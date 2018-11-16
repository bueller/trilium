"use strict";

const Attribute = require('../../entities/attribute');
const Link = require('../../entities/link');
const log = require('../../services/log');
const utils = require('../../services/utils');
const noteService = require('../../services/notes');
const Branch = require('../../entities/branch');
const tar = require('tar-stream');
const stream = require('stream');
const path = require('path');
const commonmark = require('commonmark');

/**
 * Complication of this export is the need to balance two needs:
 * -
 */
async function importTar(file, parentNote) {
    const files = await parseImportFile(file);

    const ctx = {
        // maps from original noteId (in tar file) to newly generated noteId
        noteIdMap: {},
        // new noteIds of notes which were actually created (not just referenced)
        createdNoteIds: [],
        attributes: [],
        links: [],
        reader: new commonmark.Parser(),
        writer: new commonmark.HtmlRenderer()
    };

    ctx.getNewNoteId = function(origNoteId) {
        // in case the original noteId is empty. This probably shouldn't happen, but still good to have this precaution
        if (!origNoteId.trim()) {
            return "";
        }

        if (!ctx.noteIdMap[origNoteId]) {
            ctx.noteIdMap[origNoteId] = utils.newEntityId();
        }

        return ctx.noteIdMap[origNoteId];
    };

    const note = await importNotes(ctx, files, parentNote.noteId);

    // we save attributes and links after importing notes because we need to check that target noteIds
    // have been really created (relation/links with targets outside of the export are not created)

    for (const attr of ctx.attributes) {
        if (attr.type === 'relation') {
            attr.value = ctx.getNewNoteId(attr.value);

            if (!ctx.createdNoteIds.includes(attr.value)) {
                // relation targets note outside of the export
                continue;
            }
        }

        await new Attribute(attr).save();
    }

    for (const link of ctx.links) {
        link.targetNoteId = ctx.getNewNoteId(link.targetNoteId);

        if (!ctx.createdNoteIds.includes(link.targetNoteId)) {
            // link targets note outside of the export
            continue;
        }

        await new Link(link).save();
    }

    return note;
}

function getFileName(name) {
    let key;

    if (name.endsWith(".dat")) {
        key = "data";
        name = name.substr(0, name.length - 4);
    }
    else if (name.endsWith(".md")) {
        key = "markdown";
        name = name.substr(0, name.length - 3);
    }
    else if (name.endsWith((".meta"))) {
        key = "meta";
        name = name.substr(0, name.length - 5);
    }
    else {
        log.error("Unknown file type in import: " + name);
    }

    return {name, key};
}

async function parseImportFile(file) {
    const fileMap = {};
    const files = [];

    const extract = tar.extract();

    extract.on('entry', function(header, stream, next) {
        let name, key;

        if (header.type === 'file') {
            ({name, key} = getFileName(header.name));
        }
        else if (header.type === 'directory') {
            // directory entries in tar often end with directory separator
            name = (header.name.endsWith("/") || header.name.endsWith("\\")) ? header.name.substr(0, header.name.length - 1) : header.name;
            key = 'directory';
        }
        else {
            log.error("Unrecognized tar entry: " + JSON.stringify(header));
            return;
        }

        let file = fileMap[name];

        if (!file) {
            file = fileMap[name] = {
                name: path.basename(name),
                children: []
            };

            let parentFileName = path.dirname(header.name);

            if (parentFileName && parentFileName !== '.') {
                fileMap[parentFileName].children.push(file);
            }
            else {
                files.push(file);
            }
        }

        const chunks = [];

        stream.on("data", function (chunk) {
            chunks.push(chunk);
        });

        // header is the tar header
        // stream is the content body (might be an empty stream)
        // call next when you are done with this entry

        stream.on('end', function() {
            file[key] = Buffer.concat(chunks);

            if (key === "meta") {
                file[key] = JSON.parse(file[key].toString("UTF-8"));
            }

            next(); // ready for next entry
        });

        stream.resume(); // just auto drain the stream
    });

    return new Promise(resolve => {
        extract.on('finish', function() {
            resolve(files);
        });

        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);

        bufferStream.pipe(extract);
    });
}

async function importNotes(ctx, files, parentNoteId) {
    let returnNote = null;

    for (const file of files) {
        let note;

        if (!file.meta) {
            let content = '';

            if (file.data) {
                content = file.data.toString("UTF-8");
            }
            else if (file.markdown) {
                const parsed = ctx.reader.parse(file.markdown.toString("UTF-8"));
                content = ctx.writer.render(parsed);
            }

            note = (await noteService.createNote(parentNoteId, file.name, content, {
                type: 'text',
                mime: 'text/html'
            })).note;
        }
        else {
            if (file.meta.version !== 1) {
                throw new Error("Can't read meta data version " + file.meta.version);
            }

            if (file.meta.clone) {
                await new Branch({
                    parentNoteId: parentNoteId,
                    noteId: ctx.getNewNoteId(file.meta.noteId),
                    prefix: file.meta.prefix,
                    isExpanded: !!file.meta.isExpanded
                }).save();

                return;
            }

            if (file.meta.type !== 'file' && file.meta.type !== 'image') {
                file.data = file.data.toString("UTF-8");

                // this will replace all internal links (<a> and <img>) inside the body
                // links pointing outside the export will be broken and changed (ctx.getNewNoteId() will still assign new noteId)
                for (const link of file.meta.links || []) {
                    // no need to escape the regexp find string since it's a noteId which doesn't contain any special characters
                    file.data = file.data.replace(new RegExp(link.targetNoteId, "g"), ctx.getNewNoteId(link.targetNoteId));
                }
            }

            note = (await noteService.createNote(parentNoteId, file.meta.title, file.data, {
                noteId: ctx.getNewNoteId(file.meta.noteId),
                type: file.meta.type,
                mime: file.meta.mime,
                prefix: file.meta.prefix
            })).note;

            ctx.createdNoteIds.push(note.noteId);

            for (const attribute of file.meta.attributes || []) {
                ctx.attributes.push({
                    noteId: note.noteId,
                    type: attribute.type,
                    name: attribute.name,
                    value: attribute.value,
                    isInheritable: attribute.isInheritable,
                    position: attribute.position
                });
            }

            for (const link of file.meta.links || []) {
                ctx.links.push({
                    noteId: note.noteId,
                    type: link.type,
                    targetNoteId: link.targetNoteId
                });
            }
        }

        // first created note will be activated after import
        returnNote = returnNote || note;

        if (file.children.length > 0) {
            await importNotes(ctx, file.children, note.noteId);
        }
    }

    return returnNote;
}

module.exports = {
    importTar
};