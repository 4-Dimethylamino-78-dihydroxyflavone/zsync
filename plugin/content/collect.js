/* global Zsync, Zotero, IOUtils, DOMParser */
// Reads one collection (read only) and shapes it into the annotations.json
// model described in docs/SCHEMA.md. File copying and image rendering happen
// later, in exporter.js; this module only records what they need.
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.collect = (() => {
  const { parseExtra, isoFromMultipart, isoFromSQL, sortedObject, log } = Zsync.util;

  // "user" | "group:<groupID>" -> libraryID, or throw
  function libraryIDFor(spec) {
    if (!spec || spec === "user") return Zotero.Libraries.userLibraryID;
    const m = String(spec).match(/^group:(\d+)$/);
    if (!m) throw new Error(`zsync.json "library" must be "user" or "group:<groupID>", not ${JSON.stringify(spec)}`);
    const id = Zotero.Groups.getLibraryIDFromGroupID(Number(m[1]));
    if (!id) throw new Error(`group ${m[1]} is not in this Zotero (join it or sync first)`);
    return id;
  }

  // The inverse, for writing zsync.json
  function librarySpecFor(libraryID) {
    if (libraryID === Zotero.Libraries.userLibraryID) return "user";
    const lib = Zotero.Libraries.get(libraryID);
    if (lib && lib.libraryType === "group") return `group:${Zotero.Groups.getGroupIDFromLibraryID(libraryID)}`;
    throw new Error("zsync works with My Library and group libraries only");
  }

  // The native field, or Better BibTeX's own store (read-only group
  // libraries, where BBT cannot write the field).
  function citationKeyOf(item) {
    const native = String(item.getField("citationKey") || "").trim();
    if (native) return native;
    try {
      const k = Zotero.BetterBibTeX && Zotero.BetterBibTeX.KeyManager && Zotero.BetterBibTeX.KeyManager.get(item.id);
      if (k && k.citationKey) return String(k.citationKey);
    }
    catch (e) {}
    return "";
  }

  function filenameOf(att) {
    try { return att.attachmentFilename || null; }
    catch (e) { return null; }
  }

  // "library" or "groups/<groupID>", as zotero:// URLs want it
  function libraryPath(libraryID) {
    if (Zotero.API && typeof Zotero.API.getLibraryPrefix === "function") return Zotero.API.getLibraryPrefix(libraryID);
    if (libraryID === Zotero.Libraries.userLibraryID) return "library";
    return `groups/${Zotero.Groups.getGroupIDFromLibraryID(libraryID)}`;
  }

  async function resolveCollection(cfg) {
    const libraryID = libraryIDFor(cfg.library);
    // Zotero loads a library's items lazily (when it is first opened)
    await Zotero.Libraries.get(libraryID).waitForDataLoad("item");
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, cfg.collection);
    if (!collection) throw new Error(`collection ${cfg.collection} not found in ${cfg.library || "user"} library`);
    if (collection.deleted) throw new Error(`collection "${collection.name}" is in the trash`);
    return collection;
  }

  // The collections an export covers: the project's collection, plus its
  // descendants when recursive (skipping trashed ones).
  function coveredCollections(collection, recursive) {
    const out = [collection];
    if (recursive) {
      for (const c of Zotero.Collections.getByParent(collection.id, true)) {
        if (!c.deleted) out.push(c);
      }
    }
    return out;
  }

  // Regular items and standalone file attachments directly in the covered
  // collections, not in the trash, each once.
  async function topLevelItems(collections) {
    const seen = new Map();
    // Zotero.X.loadDataTypes only queries what is not in memory yet, which
    // after waitForDataLoad (see resolveCollection) is nothing; loadDataType
    // and loadAllData would query the database again every time.
    await Zotero.Collections.loadDataTypes(collections, ["childItems"]);
    for (const c of collections) {
      for (const item of c.getChildItems(false, false)) {
        if (item.deleted || seen.has(item.id)) continue;
        if (item.isRegularItem() || item.isFileAttachment()) seen.set(item.id, item);
      }
    }
    return [...seen.values()];
  }

  function creatorName(c) {
    if (c.name) return c.name;
    return [c.firstName, c.lastName].filter(Boolean).join(" ");
  }

  function tagNames(item) {
    return item.getTags().map((t) => String(t.tag)).sort((a, b) => a.localeCompare(b));
  }

  function parsePosition(json) {
    try { return JSON.parse(json || "null"); }
    catch (e) { return null; }
  }

  // Which message of its thread each email highlight is in, kept while the
  // snapshot file and the highlight stay the same, so that an export does
  // not read and parse every saved thread again.
  // path -> { stamp: "<size>:<mtime>", found: Map(position + text -> message) }
  const threads = new Map();

  async function threadCache(path) {
    const st = await IOUtils.stat(path).catch(() => null);
    const stamp = st ? `${st.size}:${st.lastModified}` : null;
    let entry = threads.get(path);
    if (!entry || entry.stamp !== stamp) {
      entry = { stamp, found: new Map() };
      threads.set(path, entry);
    }
    return entry.found;
  }

  async function readSnapshot(path, charset) {
    let html;
    try {
      html = await Zotero.File.getContentsAsync(path, charset || "utf-8");
    }
    catch (e) {
      html = await IOUtils.readUTF8(path);
    }
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    return Zsync.snapshot.prepare(doc);
  }

  function byTitleThenKey(a, b) {
    const ta = String(a.getField("title") || "");
    const tb = String(b.getField("title") || "");
    return ta.localeCompare(tb) || a.key.localeCompare(b.key);
  }

  // Build the model. Returns { data, regularItems, files } where data is the
  // annotations.json object (minus file/image paths, filled in later), and
  // files lists what exporter.js may copy or render.
  async function build(cfg, prev = null) {
    const collection = await resolveCollection(cfg);
    const libraryID = collection.libraryID;
    const libPath = libraryPath(libraryID);
    const collections = coveredCollections(collection, cfg.recursive);
    const tops = await topLevelItems(collections);
    const warnings = [];

    const items = {};
    const attachments = {};
    const annotations = {};
    const regularItems = [];
    const files = [];           // { key, path, contentType, annotated, record }
    const imageAnnotations = [];  // { annotation item, attachment item, record }
    const usedCitekeys = new Map();
    const trackedIDs = [];      // attachment and annotation item IDs

    await Zotero.Items.loadDataTypes(tops);
    const regular = tops.filter((i) => i.isRegularItem());
    const standalone = tops.filter((i) => !i.isRegularItem());

    // citation keys first, so every attachment and annotation can refer to them
    const citekeyOf = new Map();
    const realCitekey = new Map();
    for (const item of [...regular].sort((a, b) => a.key.localeCompare(b.key))) {
      let ck = citationKeyOf(item);
      realCitekey.set(item.id, ck || null);
      if (!ck) {
        ck = item.key;
        warnings.push(`item ${item.key} ("${item.getField("title", false, true)}") has no citation key; keyed by its item key`);
      }
      if (usedCitekeys.has(ck)) {
        const other = usedCitekeys.get(ck);
        const alt = `${ck}-${item.key}`;
        warnings.push(`citation key ${ck} is used by items ${other} and ${item.key}; the second is keyed ${alt}`);
        ck = alt;
      }
      usedCitekeys.set(ck, item.key);
      citekeyOf.set(item.id, ck);
    }

    // owner: the entry in `items` this attachment belongs to, as
    // { key: its Zotero key, citekey: its key in items }, or null
    const addAttachment = async (att, owner) => {
      await Zotero.Items.loadDataTypes([att]);
      trackedIDs.push(att.id);
      const citekey = owner ? owner.citekey : null;
      const reader = att.attachmentReaderType || null;
      const rec = {
        "key": att.key,
        "item": owner ? owner.key : null,
        "citekey": citekey,
        "title": att.getField("title") || null,
        "filename": filenameOf(att),
        "content-type": att.attachmentContentType || null,
        "reader": reader,
        "file": null,
        "open": `zotero://open/${libPath}/items/${att.key}`,
        "annotations": [],
      };
      const path = await att.getFilePathAsync();
      if (!path) {
        warnings.push(`the file of attachment ${att.key} ("${rec.title || rec.filename}") is not on this device`);
      }

      let snapshot;  // parsed lazily, once, and only for highlights not seen before
      const found = reader === "snapshot" && path ? await threadCache(path) : null;
      const anns = reader ? att.getAnnotations(false) : [];
      anns.sort((a, b) => String(a.annotationSortIndex).localeCompare(String(b.annotationSortIndex)) || a.key.localeCompare(b.key));
      for (const a of anns) {
        trackedIDs.push(a.id);
        const position = parsePosition(a.annotationPosition);
        const isPDF = reader === "pdf";
        const type = a.annotationType;
        const annRec = {
          "key": a.key,
          "citekey": citekey,
          "item": owner ? owner.key : null,
          "attachment": att.key,
          "type": type,
          "text": (type === "highlight" || type === "underline") ? (a.annotationText || "") : null,
          "comment": a.annotationComment || null,
          "color": a.annotationColor || null,
          "tags": tagNames(a),
          "page": a.annotationPageLabel || null,
          "page-index": isPDF && position && Number.isInteger(position.pageIndex) ? position.pageIndex : null,
          "sort": a.annotationSortIndex || null,
          "position": position,
          "rects": isPDF && position && Array.isArray(position.rects) ? position.rects : null,
          "next-page-rects": isPDF && position && Array.isArray(position.nextPageRects) ? position.nextPageRects : null,
          "image": null,
          "author": a.annotationAuthorName || null,
          "created": isoFromSQL(a.dateAdded),
          "modified": isoFromSQL(a.dateModified),
          "link": `zotero://open/${libPath}/items/${att.key}?annotation=${a.key}`,
          "message": null,
        };
        if (found && (type === "highlight" || type === "underline")) {
          const seen = `${a.annotationPosition}\n${a.annotationText}`;
          if (found.has(seen)) {
            annRec.message = found.get(seen);
          }
          else {
            if (snapshot === undefined) {
              try {
                snapshot = await readSnapshot(path, att.attachmentCharset);
              }
              catch (e) {
                snapshot = null;
                warnings.push(`could not read snapshot ${att.key}: ${e.message}`);
              }
            }
            if (snapshot) {
              annRec.message = snapshot.message(position, a.annotationText);
              found.set(seen, annRec.message);
            }
          }
        }
        if (type === "image" || type === "ink") imageAnnotations.push({ annotation: a, attachment: att, record: annRec });
        annotations[a.key] = annRec;
        rec.annotations.push(a.key);
        if (owner) items[citekey].annotations.push(a.key);
      }
      attachments[att.key] = rec;
      // also when the file is not on this device: the exporter must not mistake
      // that for "no longer wanted" and delete the copy made elsewhere
      files.push({ key: att.key, attachment: att, path: path || null, record: rec, annotated: rec.annotations.length > 0 });
      if (owner) items[citekey].attachments.push(att.key);
    };

    for (const item of regular) {
      const ck = citekeyOf.get(item.id);
      items[ck] = {
        "key": item.key,
        "citekey": realCitekey.get(item.id),
        "type": item.itemType,
        "title": item.getField("title", false, true) || null,
        "short-title": item.getField("shortTitle", false, true) || null,
        "date": item.getField("date") || null,
        "date-iso": isoFromMultipart(item.getField("date", true)),
        "url": item.getField("url") || null,
        "creators": item.getCreatorsJSON().map((c) => ({ name: creatorName(c), role: c.creatorType })),
        "extra": parseExtra(item.getField("extra")),
        "tags": tagNames(item),
        "select": `zotero://select/${libPath}/items/${item.key}`,
        "attachments": [],
        "annotations": [],
        "standalone": false,
        "inferred": {},
      };
      regularItems.push(item);
      const atts = (await Zotero.Items.getAsync(item.getAttachments(false)))
        .filter((a) => a && a.isFileAttachment() && !a.deleted)
        .sort(byTitleThenKey);
      for (const att of atts) await addAttachment(att, { key: item.key, citekey: ck });
    }

    // Files with no parent item: an item of their own (see standalone.js),
    // unless zsync.json asks for the old behaviour.
    const standaloneItems = [];
    const sortedStandalone = standalone.sort(byTitleThenKey);
    if (cfg.standalone === "items") {
      // what the last export (on any device) said about each document
      const prevDocs = (prev && prev.documents && typeof prev.documents === "object") ? prev.documents : {};
      const docs = [];
      for (const att of sortedStandalone) {
        const override = cfg.documents[att.key] || {};
        const input = { attTitle: att.getField("title") || "", filename: filenameOf(att), overrides: override };
        const path = att.isPDFAttachment() ? await att.getFilePathAsync() : null;
        const before = prevDocs[att.key];
        let desc;
        if (att.isPDFAttachment() && !path && before && before.title) {
          // The PDF is not on this device, so its text cannot be read: keep
          // what the last export found rather than fall back to the file
          // name (which would change the type, title and key).
          // zsync.json overrides still win.
          const base = Zsync.standalone.describe(input);
          desc = {
            type: override.type ? base.type : (before.type || base.type),
            title: override.title ? base.title : before.title,
            date: override.date ? base.date : (before.date || base.date),
            creators: (override.author || override.recipient || !Array.isArray(before.creators)) ? base.creators : before.creators,
            inferred: before.inferred || {},
            titleFallback: false,
          };
          warnings.push(`the file of ${att.key} is not on this device; kept its description from the last export`);
        }
        else {
          const pdf = path ? await Zsync.standalone.readPdf(att, path) : null;
          // is it a letter (or a printed email)? read the top of the first page
          if (pdf && !override.type) input.letter = Zsync.standalone.recogniseLetter(pdf.lines.join("\n"));
          desc = Zsync.standalone.describe(input);
          // the PDF's own metadata, for what name and text leave open
          const open = desc.titleFallback || !desc.date || !desc.creators.some((c) => c.role === "author");
          if (open && pdf && pdf.meta) desc = Zsync.standalone.describe({ ...input, pdf: pdf.meta });
        }
        const year = (String(desc.date || "").match(/^\d{4}/) || [""])[0];
        docs.push({ att, desc, attKey: att.key, dateAdded: att.dateAdded, override: override.citekey, base: Zsync.standalone.baseCitekey(desc), year });
      }
      const prevKeys = new Map(Object.entries(prevDocs).filter(([, v]) => v && v.citekey).map(([k, v]) => [k, v.citekey]));
      const { keys, warnings: keyWarnings } = Zsync.standalone.assignCitekeys(docs, Object.keys(items), prevKeys);
      warnings.push(...keyWarnings);
      for (const { att, desc } of docs) {
        const ck = keys.get(att.key);
        const iso = (String(desc.date || "").match(/^\d{4}(?:-\d{2}(?:-\d{2})?)?/) || [null])[0];
        items[ck] = {
          "key": att.key,
          "citekey": ck,
          "type": desc.type,
          "title": desc.title,
          "short-title": null,
          "date": desc.date,
          "date-iso": iso,
          "url": att.getField("url") || null,
          "creators": desc.creators,
          "extra": {},
          "tags": tagNames(att),
          "select": `zotero://select/${libPath}/items/${att.key}`,
          "attachments": [],
          "annotations": [],
          "standalone": true,
          "inferred": desc.inferred,
        };
        standaloneItems.push(items[ck]);
        await addAttachment(att, { key: att.key, citekey: ck });
      }
      await Zsync.standalone.saveCache();
    }
    else {
      for (const att of sortedStandalone) await addAttachment(att, null);
    }

    log(`collected ${regular.length} items, ${Object.keys(attachments).length} attachments, ${Object.keys(annotations).length} annotations from "${collection.name}"`);

    const data = {
      zsync: 1,
      collection: { key: collection.key, name: collection.name, library: libPath },
      items: sortedObject(items),
      attachments: sortedObject(attachments),
      annotations: sortedObject(annotations),
      warnings,
    };
    // What auto-export watches: every object this export read.
    const index = {
      libraryID,
      recursive: !!cfg.recursive,
      collectionIDs: collections.map((c) => c.id),
      ids: [...tops.map((i) => i.id), ...trackedIDs],
      keys: [...tops.map((i) => i.key), ...Object.keys(attachments), ...Object.keys(annotations)],
    };
    return { collection, data, regularItems, standaloneItems, files, imageAnnotations, warnings, index };
  }

  return { libraryIDFor, librarySpecFor, libraryPath, resolveCollection, coveredCollections, citationKeyOf, build };
})();
