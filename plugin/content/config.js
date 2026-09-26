/* global Zsync, Zotero, IOUtils, PathUtils */
// zsync.json (per project, travels with the project) and the list of project
// folders on this device (a Zotero preference).
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.config = (() => {
  const { projectPath, relPath, readTextIfExists, writeTextIfChanged, stableStringify, isKey } = Zsync.util;

  const FILE = "zsync.json";
  const PREF_ROOTS = "extensions.zsync.projectRoots";

  const DEFAULTS = {
    zsync: 1,
    library: "user",
    collection: null,
    name: null,
    recursive: false,
    annotations: "refs/annotations.json",
    bib: "refs/zsync.bib",
    bibTranslator: "Better BibLaTeX",
    bibStripFields: ["file"],
    copySources: "annotated",
    sources: "refs/zsync/sources",
    renderImages: true,
    images: "refs/zsync/images",
    manifest: "refs/zsync/manifest.json",
    standalone: "items",
    documents: {},
    id: null,
  };
  const COPY_MODES = ["none", "annotated", "all"];
  const STANDALONE_MODES = ["items", "attachments"];
  const DOCUMENT_FIELDS = ["citekey", "title", "date", "author", "recipient", "type"];

  function fail(root, msg) {
    throw new Error(`${PathUtils.join(root, FILE)}: ${msg}`);
  }

  // Parse and check a zsync.json text; returns the config with defaults filled
  // in and output paths resolved against root (as .paths).
  function parse(root, text) {
    let raw;
    try {
      raw = JSON.parse(String(text).replace(/^﻿/, ""));
    }
    catch (e) {
      fail(root, `not valid JSON (${e.message})`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(root, "must be a JSON object");
    const cfg = { ...DEFAULTS, ...raw };
    if (cfg.zsync !== 1) fail(root, `unsupported "zsync" version ${JSON.stringify(cfg.zsync)} (this zsync understands 1)`);
    if (!isKey(cfg.collection)) fail(root, `"collection" must be an 8-character Zotero collection key`);
    if (typeof cfg.library !== "string" || !/^(user|group:\d+)$/.test(cfg.library)) fail(root, `"library" must be "user" or "group:<groupID>"`);
    if (typeof cfg.recursive !== "boolean") fail(root, `"recursive" must be true or false`);
    if (typeof cfg.renderImages !== "boolean") fail(root, `"renderImages" must be true or false`);
    if (!COPY_MODES.includes(cfg.copySources)) fail(root, `"copySources" must be one of ${COPY_MODES.join(", ")}`);
    if (!Array.isArray(cfg.bibStripFields) || !cfg.bibStripFields.every((f) => typeof f === "string")) {
      fail(root, `"bibStripFields" must be a list of field names`);
    }
    if (typeof cfg.bibTranslator !== "string" || !cfg.bibTranslator) fail(root, `"bibTranslator" must be a translator label or ID`);
    for (const k of ["annotations", "sources", "images", "manifest"]) {
      if (typeof cfg[k] !== "string" || !cfg[k].trim()) fail(root, `"${k}" must be a path`);
    }
    if (cfg.bib !== null && (typeof cfg.bib !== "string" || !cfg.bib.trim())) fail(root, `"bib" must be a path or null`);
    if (!STANDALONE_MODES.includes(cfg.standalone)) fail(root, `"standalone" must be one of ${STANDALONE_MODES.join(", ")}`);
    if (cfg.id !== null && (typeof cfg.id !== "string" || !/^[A-Za-z0-9-]{4,64}$/.test(cfg.id))) fail(root, `"id" must be letters, digits and dashes`);
    if (!cfg.documents || typeof cfg.documents !== "object" || Array.isArray(cfg.documents)) {
      fail(root, `"documents" must be an object keyed by attachment key`);
    }
    for (const [key, doc] of Object.entries(cfg.documents)) {
      if (!isKey(key)) fail(root, `"documents": ${JSON.stringify(key)} is not an 8-character Zotero attachment key`);
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail(root, `"documents.${key}" must be an object`);
      for (const [field, value] of Object.entries(doc)) {
        if (!DOCUMENT_FIELDS.includes(field)) fail(root, `"documents.${key}.${field}" is not one of ${DOCUMENT_FIELDS.join(", ")}`);
        const names = field === "author" || field === "recipient";
        const ok = names
          ? (typeof value === "string" && value.trim()) || (Array.isArray(value) && value.length && value.every((v) => typeof v === "string" && v.trim()))
          : typeof value === "string" && value.trim();
        if (!ok) fail(root, `"documents.${key}.${field}" must be ${names ? "a name or a list of names" : "a non-empty string"}`);
        if (field === "type" && !/^[A-Za-z]+$/.test(value)) fail(root, `"documents.${key}.type" must be a Zotero item type such as letter, email or document`);
      }
      if (doc.citekey !== undefined && !/^[A-Za-z0-9_:.\-+/]+$/.test(doc.citekey)) {
        fail(root, `"documents.${key}.citekey" may only contain letters, digits and _ : . - + /`);
      }
      if (doc.date !== undefined && !validDate(doc.date)) {
        fail(root, `"documents.${key}.date" must be a real date like 2026, 2026-09, 2026-09-04 or 2026-09-04T13:05`);
      }
    }
    const byCitekey = new Map();
    for (const [key, doc] of Object.entries(cfg.documents)) {
      if (doc.citekey === undefined) continue;
      if (byCitekey.has(doc.citekey)) fail(root, `"documents.${byCitekey.get(doc.citekey)}.citekey" and "documents.${key}.citekey" are both ${JSON.stringify(doc.citekey)}`);
      byCitekey.set(doc.citekey, key);
    }
    const paths = {};
    try {
      for (const k of ["annotations", "sources", "images", "manifest"]) paths[k] = projectPath(root, cfg[k]);
      paths.bib = cfg.bib === null ? null : projectPath(root, cfg.bib);
    }
    catch (e) {
      fail(root, e.message);
    }
    // Outputs may not be zsync.json itself (in any spelling) or each other.
    const spell = (rel) => relPath(String(rel)).normalize("NFC").split("/").map((s) => s.replace(/[. ]+$/, "")).join("/").toLowerCase();
    const files = [["annotations", cfg.annotations], ["manifest", cfg.manifest], ...(cfg.bib === null ? [] : [["bib", cfg.bib]])];
    for (const [k, rel] of [...files, ["sources", cfg.sources], ["images", cfg.images]]) {
      if (spell(rel) === spell(FILE)) fail(root, `"${k}" cannot be ${FILE} itself`);
      if (/:/.test(relPath(rel))) fail(root, `"${k}" may not contain ":"`);
    }
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        if (spell(files[i][1]) === spell(files[j][1])) fail(root, `"${files[i][0]}" and "${files[j][0]}" name the same file`);
      }
    }
    return { ...cfg, root, paths };
  }

  // 2026, 2026-09, 2026-09-04 or 2026-09-04T13:05[:07], all parts in range
  function validDate(s) {
    const m = String(s).match(/^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)?)?)?$/);
    if (!m) return false;
    if (m[2] === undefined) return true;
    if (!(+m[2] >= 1 && +m[2] <= 12)) return false;
    if (m[3] === undefined) return true;
    return Zsync.standalone.validYMD(+m[1], +m[2], +m[3]);
  }

  async function read(root) {
    const text = await readTextIfExists(PathUtils.join(root, FILE));
    if (text === null) return null;
    return parse(root, text);
  }

  // A new zsync.json for a collection. Only the keys a person is likely to
  // change are written; everything else keeps its default.
  // A random id that tells this project folder apart from other folders
  // linked to the same collection, so a renamed or moved one can be found.
  function newID() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function create(root, collection) {
    const cfg = {
      zsync: 1,
      id: newID(),
      library: Zsync.collect.librarySpecFor(collection.libraryID),
      collection: collection.key,
      name: collection.name,
      recursive: false,
      annotations: DEFAULTS.annotations,
      bib: DEFAULTS.bib,
      copySources: DEFAULTS.copySources,
      renderImages: DEFAULTS.renderImages,
    };
    await IOUtils.makeDirectory(root, { createAncestors: true, ignoreExisting: true });
    await writeTextIfChanged(PathUtils.join(root, FILE), stableStringify(cfg));
    return parse(root, stableStringify(cfg));
  }

  // Re-point an existing zsync.json at another collection, keeping every
  // other setting.
  async function relink(root, collection) {
    const file = PathUtils.join(root, FILE);
    const raw = JSON.parse(String(await IOUtils.readUTF8(file)).replace(/^﻿/, ""));
    const library = Zsync.collect.librarySpecFor(collection.libraryID);
    // pointed at another collection, the folder is a different project now
    if (raw.collection !== collection.key || raw.library !== library) raw.id = newID();
    raw.library = library;
    raw.collection = collection.key;
    raw.name = collection.name;
    await writeTextIfChanged(file, stableStringify(raw));
    return read(root);
  }

  // ---- project folders on this device
  function normalize(path) {
    return PathUtils.normalize(String(path).trim());
  }

  function sameFolder(a, b) {
    const n = (p) => normalize(p).replace(/[\\/]+$/, "");
    return Zotero.isWin ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
  }

  function roots() {
    let list;
    try {
      list = JSON.parse(Zotero.Prefs.get(PREF_ROOTS, true) || "[]");
    }
    catch (e) {
      list = [];
    }
    return Array.isArray(list) ? list.filter((p) => typeof p === "string" && p) : [];
  }

  function setRoots(list) {
    const unique = [];
    for (const p of list) {
      if (!unique.some((q) => sameFolder(p, q))) unique.push(normalize(p));
    }
    Zotero.Prefs.set(PREF_ROOTS, JSON.stringify(unique), true);
    return unique;
  }

  function addRoot(path) {
    return setRoots([...roots(), path]);
  }

  // Register a folder whose zsync.json has just been read or written.
  function addProject(path, cfg) {
    const list = addRoot(path);
    rememberIdentity(path, cfg);
    return list;
  }

  function removeRoot(path) {
    forgetIdentity(path);
    return setRoots(roots().filter((p) => !sameFolder(p, path)));
  }

  // ---- what each folder was linked to, remembered on this device so that a
  // folder that has been renamed or moved can still be recognised
  const PREF_IDS = "extensions.zsync.projectIdentities";

  function idKey(path) {
    const n = normalize(path).replace(/[\\/]+$/, "");
    return Zotero.isWin ? n.toLowerCase() : n;
  }

  function identities() {
    try {
      const o = JSON.parse(Zotero.Prefs.get(PREF_IDS, true) || "{}");
      return o && typeof o === "object" && !Array.isArray(o) ? o : {};
    }
    catch (e) {
      return {};
    }
  }

  function identityOf(path) {
    return identities()[idKey(path)] || null;
  }

  function rememberIdentity(path, cfg) {
    const all = identities();
    const id = { id: cfg.id || null, library: cfg.library, collection: cfg.collection, name: cfg.name || null, manifest: relPath(cfg.manifest || DEFAULTS.manifest) };
    const k = idKey(path);
    if (JSON.stringify(all[k]) === JSON.stringify(id)) return;
    all[k] = id;
    Zotero.Prefs.set(PREF_IDS, JSON.stringify(all), true);
  }

  function forgetIdentity(path) {
    const all = identities();
    if (!(idKey(path) in all)) return;
    delete all[idKey(path)];
    Zotero.Prefs.set(PREF_IDS, JSON.stringify(all), true);
  }

  // Every registered project, read fresh: [{ root, cfg, error, missing }].
  // missing: the folder itself is not there (renamed, moved or unplugged).
  async function projects() {
    const out = [];
    for (const root of roots()) {
      let missing = false;
      try {
        const cfg = await read(root);
        if (cfg) {
          rememberIdentity(root, cfg);
          out.push({ root, cfg, error: null, missing: false });
          continue;
        }
        missing = !(await IOUtils.exists(root));
        out.push({ root, cfg: null, error: missing ? "folder not found (renamed, moved or on a drive that is not connected?)" : `no ${FILE} in this folder`, missing });
      }
      catch (e) {
        out.push({ root, cfg: null, error: e.message, missing });
      }
    }
    return out;
  }

  // Registered projects whose zsync.json points at this collection.
  async function projectsFor(collection) {
    const spec = Zsync.collect.librarySpecFor(collection.libraryID);
    return (await projects()).filter((p) => p.cfg && p.cfg.collection === collection.key && p.cfg.library === spec);
  }

  // Registered folders remembered as linked to this collection, whether or
  // not they can be read right now (synchronous, for menus).
  function rootsRememberedFor(collection) {
    let spec;
    try { spec = Zsync.collect.librarySpecFor(collection.libraryID); }
    catch (e) { return []; }
    return roots().filter((r) => {
      const id = identityOf(r);
      return id && id.collection === collection.key && id.library === spec;
    });
  }

  // ---- finding a folder that was renamed or moved
  const SKIP_DIRS = /^(\.|node_modules$|__pycache__$|\$recycle\.bin$|system volume information$)/i;

  // Where a volume's mount points live: a folder whose first missing part
  // sits directly in one of these is probably on a drive that is unplugged.
  function isMountContainer(dir) {
    const d = normalize(dir).replace(/[\/]+$/, "") || "/";
    return /^\/(Volumes|mnt|media|media\/[^/]+|run\/media\/[^/]+)$/.test(d) || d === "/" || d === "";
  }

  // Look near where the folder used to be for its zsync.json: under its
  // nearest surviving parent, a few levels deep, within a time and size
  // budget. A folder matches when its zsync.json names the same collection
  // (and, for folders linked with an id, the same project id; copies share
  // it). Returns { identity, candidates (best first), best, back,
  // volumeMissing, searched, truncated }:
  //   back: the folder is there again;
  //   volumeMissing: the name of a drive that seems to be unplugged (no search).
  async function findMoved(root, { maxDepth = 3, maxDirs = 4000, maxEntries = 50000, timeLimit = 8000 } = {}) {
    const identity = identityOf(root);
    const result = { identity, candidates: [], best: null, back: false, volumeMissing: null, searched: 0, truncated: false };
    if (!identity) return result;
    const matches = (cfg) => cfg.collection === identity.collection && cfg.library === identity.library
      && (!identity.id || cfg.id === identity.id);
    try {
      const cfg = await read(root);
      if (cfg && matches(cfg)) return { ...result, back: true };
    }
    catch (e) {}
    let missing = normalize(root);
    let start = PathUtils.parent(missing);
    while (start && !(await IOUtils.exists(start))) {
      const up = PathUtils.parent(start);
      if (!up || up === start) { start = null; break; }
      missing = start;
      start = up;
    }
    if (!start) return { ...result, volumeMissing: PathUtils.filename(missing) || missing };
    if (isMountContainer(start)) return { ...result, volumeMissing: PathUtils.filename(missing) };
    const others = roots().filter((r) => !sameFolder(r, root));
    const candidates = [];
    const t0 = Date.now();
    let searched = 0;
    let entries = 0;
    const over = () => searched >= maxDirs || entries >= maxEntries || Date.now() - t0 > timeLimit;
    const done = (truncated) => {
      // same folder name as before first (a renamed parent), then shortest path
      const base = PathUtils.filename(root).toLowerCase();
      candidates.sort((a, b) => (PathUtils.filename(b).toLowerCase() === base) - (PathUtils.filename(a).toLowerCase() === base) || a.length - b.length);
      let best = candidates.length === 1 ? candidates[0] : null;
      if (!best && !identity.id) {
        const same = candidates.filter((c) => PathUtils.filename(c).toLowerCase() === base);
        if (same.length === 1) best = same[0];
      }
      return { ...result, candidates, best, searched, truncated };
    };
    let level = [start];
    for (let depth = 0; depth <= maxDepth && level.length; depth++) {
      const next = [];
      for (const dir of level) {
        if (over()) return done(true);
        searched++;
        if (depth > 0 && !sameFolder(dir, root) && !others.some((o) => sameFolder(o, dir))) {
          try {
            const cfg = await read(dir);
            if (cfg && matches(cfg)) candidates.push(dir);
          }
          catch (e) {}
        }
        if (depth === maxDepth) continue;
        let children = [];
        try { children = await IOUtils.getChildren(dir); }
        catch (e) { continue; }
        children = children.filter((c) => !SKIP_DIRS.test(PathUtils.filename(c)));
        for (let i = 0; i < children.length; i += 64) {
          if (over()) return done(true);
          const chunk = children.slice(i, i + 64);
          entries += chunk.length;
          const stats = await Promise.all(chunk.map((c) => IOUtils.stat(c).catch(() => null)));
          chunk.forEach((c, j) => { if (stats[j] && stats[j].type === "directory") next.push(c); });
        }
      }
      level = next;
    }
    return done(false);
  }

  // Replace a registered folder by its new location, keeping its place in the
  // list. The new folder must hold a zsync.json for the same collection.
  async function relocate(oldRoot, newRoot) {
    const cfg = await read(newRoot);
    if (!cfg) throw new Error(`there is no ${FILE} in ${newRoot}`);
    const id = identityOf(oldRoot);
    if (id && (id.collection !== cfg.collection || id.library !== cfg.library)) {
      throw new Error(`${newRoot} is linked to another collection (${cfg.name || cfg.collection})`);
    }
    if (sameFolder(oldRoot, newRoot)) {
      // it came back where it was
      rememberIdentity(oldRoot, cfg);
      return cfg;
    }
    const list = roots();
    const i = list.findIndex((r) => sameFolder(r, oldRoot));
    const rest = list.filter((r) => !sameFolder(r, newRoot));
    const j = rest.findIndex((r) => sameFolder(r, oldRoot));
    if (i < 0 || j < 0) rest.push(newRoot);
    else rest[j] = newRoot;
    forgetIdentity(oldRoot);
    setRoots(rest);
    rememberIdentity(newRoot, cfg);
    return cfg;
  }

  return {
    FILE, PREF_ROOTS, DEFAULTS, parse, read, create, relink, roots, setRoots, addRoot, addProject, removeRoot, sameFolder,
    projects, projectsFor, identityOf, rememberIdentity, rootsRememberedFor, findMoved, relocate,
  };
})();
