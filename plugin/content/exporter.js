/* global Zsync, Zotero, IOUtils, PathUtils */
// One export of one project folder: annotations.json, the bib, copies of
// attachment files and PNGs of image/ink annotations. Idempotent: a file is
// only written when its content changes, so running it twice in a row
// changes nothing, and git diffs stay quiet. Exports never run concurrently.
//
// What zsync owns is recorded in the manifest. It only ever deletes a file
// the manifest lists, that is still exactly what zsync wrote, and that this
// export does not claim (under any spelling of the same path); it moves aside
// rather than overwrites a file at an output path that it did not write.
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.exporter = (() => {
  const U = Zsync.util;

  // Per-session cache of source file hashes, keyed by path, invalidated by
  // size or modification time.
  const hashCache = new Map();

  // Zotero announces every PNG it renders with an item 'modify' event;
  // auto-export ignores those for annotations zsync asked it to render.
  const rendered = new Map();  // annotation id -> time
  function wasRendered(id) {
    const at = rendered.get(id);
    if (at === undefined) return false;
    if (Date.now() - at > 60000) {
      rendered.delete(id);
      return false;
    }
    return true;
  }

  async function sourceHash(path, stat) {
    const hit = hashCache.get(path);
    if (hit && hit.size === stat.size && hit.mtime === stat.lastModified) return hit.sha256;
    const sha256 = await U.sha256File(path);
    hashCache.set(path, { size: stat.size, mtime: stat.lastModified, sha256 });
    return sha256;
  }

  // One spelling for every way of writing the same project-relative path:
  // Windows and macOS ignore case, Windows trailing dots and spaces, macOS
  // treats NFC and NFD alike. Used to decide what an export claims.
  function ownKey(rel) {
    return U.relPath(String(rel)).normalize("NFC").split("/")
      .map((seg) => seg.replace(/[. ]+$/, "")).join("/").toLowerCase();
  }

  function relJoin(dir, name) {
    return [U.relPath(dir), name].filter(Boolean).join("/");
  }

  function isManifest(m) {
    return !!(m && m.zsync === 1 && typeof m.outputs === "object" && typeof m.sources === "object" && typeof m.images === "object");
  }

  async function readManifestAt(root, rel) {
    let abs;
    try { abs = U.projectPath(root, rel); }
    catch (e) { return null; }
    if (Zsync.config.sameFolder(abs, PathUtils.join(root, Zsync.config.FILE))) return null;
    const text = await U.readTextIfExists(abs);
    if (text === null) return null;
    try {
      const m = JSON.parse(text);
      return isManifest(m) ? { m, rel: U.relPath(rel), abs, sha256: U.sha256Text(text) } : null;
    }
    catch (e) {
      return null;
    }
  }

  // The previous manifest: where zsync.json says it is, else where this
  // folder's manifest was last seen on this device, else the default place.
  // One found elsewhere must belong to the same collection.
  async function findManifest(root, cfg) {
    const here = cfg ? await readManifestAt(root, cfg.manifest) : null;
    if (here) return here;
    const id = Zsync.config.identityOf(root);
    const tries = [id && id.manifest, Zsync.config.DEFAULTS.manifest].filter(Boolean);
    for (const rel of tries) {
      if (cfg && ownKey(rel) === ownKey(cfg.manifest)) continue;
      const found = await readManifestAt(root, rel);
      if (found && (!cfg || (found.m.collection && found.m.collection.key === cfg.collection))) return found;
    }
    return null;
  }

  // The only way zsync deletes a file. It must be inside the project, not
  // zsync.json, and still exactly what zsync wrote (same SHA-256 as recorded).
  // Returns "deleted", "absent", "changed" (different now, not a plain file,
  // or not a usable path) or "failed" (could not be read or deleted, for
  // example because another program has it open).
  async function removeIfUnchanged(root, rel, sha256) {
    if (typeof rel !== "string" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return "changed";
    let abs;
    try { abs = U.projectPath(root, rel); }
    catch (e) { return "changed"; }
    if (Zsync.config.sameFolder(abs, PathUtils.join(root, Zsync.config.FILE))) return "changed";
    let st;
    try { st = await U.statOrNull(abs); }
    catch (e) { return "failed"; }
    if (!st) return "absent";
    if (st.type !== "regular") return "changed";
    try {
      if ((await U.sha256File(abs)) !== sha256) return "changed";
      await IOUtils.remove(abs, { retryReadonly: true });
      return "deleted";
    }
    catch (e) {
      U.log(`could not remove ${rel}: ${e.message}`);
      return "failed";
    }
  }

  // Before writing an output over an existing file that zsync did not write,
  // move that file aside (never overwriting an earlier backup).
  async function protectForeign(abs, rel, report) {
    let target = `${abs}.zsync-backup`;
    for (let i = 2; await IOUtils.exists(target); i++) target = `${abs}.zsync-backup-${i}`;
    await IOUtils.move(abs, target);
    report.warnings.push(`moved your existing ${rel} to ${PathUtils.filename(target)}, because zsync writes ${rel}`);
  }

  // The copy of an attachment whose file cannot be read here (not on this
  // device, or unreadable): keep the copy made earlier instead of losing it.
  async function keepPreviousSource(cfg, f, prev, out, why, report) {
    const before = prev && prev.sources && prev.sources[f.key];
    if (before && typeof before.path === "string" && ownKey(before.path).startsWith(ownKey(relJoin(cfg.sources, `${f.key}.`)))) {
      const st = await U.statOrNull(U.projectPath(cfg.root, before.path)).catch(() => null);
      if (st && st.type === "regular") {
        out[f.key] = before;
        f.record.file = U.relPath(before.path);
        report.warnings.push(`${why}; kept the copy ${U.relPath(before.path)} from the last export`);
        return;
      }
    }
    report.warnings.push(why);
  }

  async function exportSources(cfg, model, prev, report, out) {
    const wanted = model.files.filter((f) => cfg.copySources === "all" || (cfg.copySources === "annotated" && f.annotated));
    for (const f of wanted) {
      if (!f.path) {
        await keepPreviousSource(cfg, f, prev, out, `the file of attachment ${f.key} is not on this device`, report);
        continue;
      }
      let stat;
      try {
        stat = await IOUtils.stat(f.path);
      }
      catch (e) {
        await keepPreviousSource(cfg, f, prev, out, `could not read the file of attachment ${f.key}: ${e.message}`, report);
        continue;
      }
      const ext = U.extname(f.path) || U.extname(f.record.filename) || "bin";
      const rel = relJoin(cfg.sources, `${f.key}.${ext}`);
      const dest = U.projectPath(cfg.root, rel);
      const sha256 = await sourceHash(f.path, stat);
      const before = prev && prev.sources && prev.sources[f.key];
      const destStat = await U.statOrNull(dest);
      const upToDate = destStat && before && ownKey(before.path || "") === ownKey(rel) && before.sha256 === sha256 && destStat.size === stat.size;
      if (!upToDate) {
        // the copy may already be right (for example, written on another device)
        const same = destStat && destStat.size === stat.size && (await U.sha256File(dest)) === sha256;
        if (!same) {
          await U.copyFileAtomic(f.path, dest);
          report.changed.push(rel);
        }
      }
      out[f.key] = { path: rel, sha256, size: stat.size };
      f.record.file = rel;
    }
  }

  async function exportImages(cfg, model, prev, report, priority, out) {
    if (!cfg.renderImages) return;
    // Let Zotero render missing PNGs (PDFs only; it needs a main window), one
    // attachment at a time: renders share Zotero's single PDF worker queue.
    const needRender = new Map();
    for (const ia of model.imageAnnotations) {
      if (!ia.attachment.isPDFAttachment()) continue;
      if (!(await Zotero.Annotations.hasCacheImage(ia.annotation))) {
        if (!needRender.has(ia.attachment.id)) needRender.set(ia.attachment.id, { att: ia.attachment, ids: [] });
        needRender.get(ia.attachment.id).ids.push(ia.annotation.id);
      }
    }
    for (const { att, ids } of needRender.values()) {
      if (!Zotero.getMainWindow()) {
        report.warnings.push("image annotations are rendered once a Zotero window is open");
        break;
      }
      for (const id of ids) rendered.set(id, Date.now());
      try {
        if (await att.getFilePathAsync()) await Zotero.PDFWorker.renderAttachmentAnnotations(att.id, priority);
      }
      catch (e) {
        report.warnings.push(`Zotero could not render the image annotations of ${att.key}: ${e.message}`);
      }
    }
    for (const ia of model.imageAnnotations) {
      const key = ia.annotation.key;
      const rel = relJoin(cfg.images, `${key}.png`);
      const dest = U.projectPath(cfg.root, rel);
      const before = prev && prev.images && prev.images[key];
      const samePlace = before && ownKey(before.path || "") === ownKey(rel);
      const destStat = await U.statOrNull(dest);
      // An existing PNG is kept until the annotation itself changes, so two
      // devices that render slightly different pixels do not fight.
      if (destStat && samePlace && before.modified === ia.record.modified) {
        out[key] = before;
        ia.record.image = rel;
        continue;
      }
      const cache = Zotero.Annotations.getCacheImagePath(ia.annotation);
      if (!(await IOUtils.exists(cache))) {
        if (destStat && samePlace) {
          // keep the old picture rather than lose it
          out[key] = before;
          ia.record.image = rel;
        }
        report.warnings.push(`no image for ${ia.record.type} annotation ${key} yet (open its PDF in Zotero once, or check the file is on this device)`);
        continue;
      }
      const sha256 = await U.sha256File(cache);
      const same = destStat && (await U.sha256File(dest)) === sha256;
      if (!same) {
        await U.copyFileAtomic(cache, dest);
        report.changed.push(rel);
      }
      out[key] = { path: rel, sha256, modified: ia.record.modified };
      ia.record.image = rel;
    }
  }

  async function exportBib(cfg, model, prev, report) {
    if (!cfg.paths.bib) {
      if (model.standaloneItems.length) {
        report.warnings.push(`"bib" is null, so the ${model.standaloneItems.length} standalone documents have no bibliography entries (point "bib" at a file, or set "standalone": "attachments")`);
      }
      return null;
    }
    const { text, label, target, fallback } = await Zsync.bib.exportItems(model.regularItems, cfg.bibTranslator);
    if (fallback) report.warnings.push(`export translator "${cfg.bibTranslator}" is not installed; used Zotero's built-in "${label}"`);
    let full = text.replace(/\s+$/, "");
    if (model.standaloneItems.length) {
      if (target === "bib") full += (full ? "\n\n" : "") + Zsync.bib.standaloneEntries(model.standaloneItems, label);
      else report.warnings.push(`"${label}" does not write BibTeX, so the ${model.standaloneItems.length} standalone documents have no bibliography entries`);
    }
    const bib = Zsync.bib.finish(full, cfg.bibStripFields);
    const rel = U.relPath(cfg.bib);
    // a bib zsync did not write before is somebody's own: keep it
    const existing = await U.readTextIfExists(cfg.paths.bib);
    const ours = prev && prev.bib && ownKey(prev.bib.path || "") === ownKey(rel);
    if (existing !== null && existing !== bib && !ours) await protectForeign(cfg.paths.bib, rel, report);
    if (await U.writeTextIfChanged(cfg.paths.bib, bib)) report.changed.push(rel);
    return { path: rel, translator: label, sha256: U.sha256Text(bib) };
  }

  // The substantive part of a manifest, for deciding whether to rewrite it.
  function body(m) {
    if (!m) return null;
    return JSON.stringify({ collection: m.collection, outputs: m.outputs, sources: m.sources, images: m.images,
      bib: m.bib, documents: m.documents || {}, retry: m.retry || {} });
  }

  // What the manifest remembers about each standalone document, so that its
  // key and description survive on devices where its file is missing.
  function documentsOf(model) {
    const out = {};
    for (const it of model.standaloneItems) {
      out[it.key] = { citekey: it.citekey, type: it.type, title: it.title, date: it.date, creators: it.creators, inferred: it.inferred };
    }
    return U.sortedObject(out);
  }

  async function writeManifest(cfg, manifest, prevFound, report) {
    const rel = U.relPath(cfg.manifest);
    const text = U.stableStringify(manifest);
    const existing = await U.readTextIfExists(cfg.paths.manifest);
    if (existing !== null && existing !== text) {
      let parsed = null;
      try { parsed = JSON.parse(existing); }
      catch (e) {}
      if (!isManifest(parsed)) await protectForeign(cfg.paths.manifest, rel, report);
    }
    if (await U.writeTextIfChanged(cfg.paths.manifest, text)) report.changed.push(rel);
  }

  async function exportProject(root, { priority = true } = {}) {
    const t0 = Date.now();
    const cfg = await Zsync.config.read(root);
    if (!cfg) throw new Error(`no ${Zsync.config.FILE} in ${root}`);
    const report = { root, name: null, changed: [], removed: [], warnings: [], counts: null, ms: 0 };

    const prevFound = await findManifest(root, cfg);
    const prev = prevFound ? prevFound.m : null;
    const model = await Zsync.collect.build(cfg, prev);
    report.name = model.collection.name;
    report.warnings.push(...model.warnings);

    const sources = {};
    const images = {};
    let bib = null;
    const annRel = U.relPath(cfg.annotations);
    const manifestRel = U.relPath(cfg.manifest);
    const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    try {
      await exportSources(cfg, model, prev, report, sources);
      await exportImages(cfg, model, prev, report, priority, images);
      try {
        bib = await exportBib(cfg, model, prev, report);
      }
      catch (e) {
        report.warnings.push(`bibliography not exported: ${e.message}`);
        bib = prev ? prev.bib : null;
      }

      // Everything this export writes. Earlier outputs outside this set are
      // retired (deleted if unchanged); anything that could not be deleted is
      // remembered in the manifest and tried again next time.
      const claimed = new Set([annRel, manifestRel, bib && bib.path, ...Object.values(sources).map((e) => e.path),
        ...Object.values(images).map((e) => e.path)].filter(Boolean).map(ownKey));
      const candidates = [];
      if (prev) {
        for (const e of Object.values(prev.sources || {})) if (e && e.path) candidates.push([e.path, e.sha256]);
        for (const e of Object.values(prev.images || {})) if (e && e.path) candidates.push([e.path, e.sha256]);
        for (const [rel, sha256] of Object.entries(prev.outputs || {})) candidates.push([rel, sha256]);
        if (prev.bib && prev.bib.path) candidates.push([prev.bib.path, prev.bib.sha256]);
        for (const [rel, sha256] of Object.entries(prev.retry || {})) candidates.push([rel, sha256]);
      }
      if (prevFound && ownKey(prevFound.rel) !== ownKey(manifestRel)) candidates.push([prevFound.rel, prevFound.sha256]);
      const retry = {};
      const removedDirs = new Set();
      const seen = new Set();
      for (const [rel, sha256] of candidates) {
        const k = ownKey(rel);
        if (claimed.has(k) || seen.has(k)) continue;
        seen.add(k);
        const r = await removeIfUnchanged(root, rel, sha256);
        if (r === "deleted") {
          report.removed.push(U.relPath(rel));
          removedDirs.add(PathUtils.parent(U.projectPath(root, rel)));
        }
        else if (r === "changed") {
          report.warnings.push(`kept ${U.relPath(rel)}: zsync no longer writes it, but it changed after zsync wrote it`);
        }
        else if (r === "failed") {
          retry[U.relPath(rel)] = sha256;
          report.warnings.push(`could not delete ${U.relPath(rel)} (is it open in another program?); zsync will try again next time`);
        }
      }

      // warnings from the steps above belong in annotations.json too
      model.data.warnings = [...new Set(report.warnings)];
      const json = U.stableStringify(model.data);
      const existing = await U.readTextIfExists(cfg.paths.annotations);
      if (existing !== null && existing !== json) {
        let parsed = null;
        try { parsed = JSON.parse(existing); }
        catch (e) {}
        if (!(parsed && parsed.zsync === 1 && parsed.items && parsed.annotations)) {
          await protectForeign(cfg.paths.annotations, annRel, report);
          model.data.warnings = [...new Set(report.warnings)];
        }
      }
      const finalJson = U.stableStringify(model.data);
      if (await U.writeTextIfChanged(cfg.paths.annotations, finalJson)) report.changed.push(annRel);

      const manifest = {
        zsync: 1,
        exported: stamp(),
        plugin: Zsync.version || null,
        zotero: Zotero.version,
        collection: model.data.collection,
        outputs: { [annRel]: U.sha256Text(finalJson) },
        bib,
        sources,
        images,
        documents: documentsOf(model),
        retry: U.sortedObject(retry),
      };
      if (body(manifest) !== body(prev) || !prevFound || ownKey(prevFound.rel) !== ownKey(manifestRel)) {
        await writeManifest(cfg, manifest, prevFound, report);
      }
      await U.pruneEmptyDirs(root, [...removedDirs]);
    }
    catch (e) {
      // Record what was already copied, so nothing zsync wrote goes untracked.
      try {
        const partial = prev ? JSON.parse(JSON.stringify(prev)) : { zsync: 1, outputs: {}, bib: null, sources: {}, images: {} };
        Object.assign(partial, { exported: stamp(), plugin: Zsync.version || null, zotero: Zotero.version, collection: model.data.collection });
        partial.sources = { ...(partial.sources || {}) };
        partial.images = { ...(partial.images || {}) };
        for (const [k, v] of Object.entries(sources)) {
          if (partial.sources[k] && ownKey(partial.sources[k].path || "") !== ownKey(v.path)) partial.sources[`${k}~old`] = partial.sources[k];
          partial.sources[k] = v;
        }
        for (const [k, v] of Object.entries(images)) {
          if (partial.images[k] && ownKey(partial.images[k].path || "") !== ownKey(v.path)) partial.images[`${k}~old`] = partial.images[k];
          partial.images[k] = v;
        }
        if (Object.keys(sources).length || Object.keys(images).length) {
          await U.writeTextIfChanged(cfg.paths.manifest, U.stableStringify(partial));
        }
      }
      catch (e2) {
        U.log(`could not record a partial export: ${e2.message}`);
      }
      throw e;
    }

    report.index = model.index;
    report.counts = {
      items: Object.keys(model.data.items).length,
      attachments: Object.keys(model.data.attachments).length,
      annotations: Object.keys(model.data.annotations).length,
    };
    report.warnings = model.data.warnings;
    report.ms = Date.now() - t0;
    U.log(`exported "${report.name}" to ${root} in ${report.ms} ms: ${report.changed.length} changed, ${report.removed.length} removed, ${report.warnings.length} warnings`);
    return report;
  }

  // Delete what zsync wrote into a project folder: every file listed in its
  // manifest that is still exactly as zsync wrote it, then the manifest, and
  // zsync.json too when `config` is true. Files changed since are kept and
  // reported, files that cannot be deleted are reported as failed; nothing
  // else in the folder is touched, and the folder itself stays. Empty
  // directories zsync's files leave behind are removed.
  async function removeOutputs(root, { config = false } = {}) {
    const report = { root, deleted: [], kept: [], failed: [], noManifest: false, error: null };
    const dirs = new Set();
    try {
      let cfg = null;
      try { cfg = await Zsync.config.read(root); }
      catch (e) { cfg = null; }
      const found = await findManifest(root, cfg);
      if (found) {
        const m = found.m;
        const targets = [];
        for (const [rel, sha256] of Object.entries(m.outputs || {})) targets.push([rel, sha256]);
        if (m.bib && m.bib.path) targets.push([m.bib.path, m.bib.sha256]);
        for (const e of Object.values(m.sources || {})) if (e && e.path) targets.push([e.path, e.sha256]);
        for (const e of Object.values(m.images || {})) if (e && e.path) targets.push([e.path, e.sha256]);
        for (const [rel, sha256] of Object.entries(m.retry || {})) targets.push([rel, sha256]);
        for (const [rel, sha256] of targets) {
          const r = await removeIfUnchanged(root, rel, sha256);
          if (r === "deleted") {
            report.deleted.push(U.relPath(rel));
            dirs.add(PathUtils.parent(U.projectPath(root, rel)));
          }
          else if (r === "changed") report.kept.push(U.relPath(rel));
          else if (r === "failed") report.failed.push(U.relPath(rel));
        }
        if (report.failed.length) {
          // keep a record of what is still ours, so a later attempt can finish
          const retry = {};
          for (const [rel, sha256] of targets) if (report.failed.includes(U.relPath(rel))) retry[U.relPath(rel)] = sha256;
          await IOUtils.writeUTF8(found.abs, U.stableStringify({ ...m, outputs: {}, bib: null, sources: {}, images: {}, retry }));
        }
        else {
          try {
            await IOUtils.remove(found.abs, { ignoreAbsent: true, retryReadonly: true });
            report.deleted.push(found.rel);
            dirs.add(PathUtils.parent(found.abs));
          }
          catch (e) {
            report.failed.push(found.rel);
          }
        }
      }
      else {
        report.noManifest = true;
      }
      if (config) {
        const file = PathUtils.join(root, Zsync.config.FILE);
        if (await IOUtils.exists(file)) {
          try {
            await IOUtils.remove(file, { retryReadonly: true });
            report.deleted.push(Zsync.config.FILE);
          }
          catch (e) {
            report.failed.push(Zsync.config.FILE);
          }
        }
      }
    }
    catch (e) {
      report.error = e.message;
    }
    finally {
      await U.pruneEmptyDirs(root, [...dirs]).catch(() => {});
    }
    U.log(`removed zsync's files from ${root}: ${report.deleted.length} deleted, ${report.kept.length} kept, ${report.failed.length} failed`);
    return report;
  }

  // ---- one export at a time, and at most one waiting per project
  let chain = Promise.resolve();
  const pending = new Map();

  // Run fn after every queued export (and before any later one).
  function queue(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }

  // priority: true for exports a person asked for (their PNG renders jump
  // Zotero's PDF queue), false for automatic ones.
  function run(root, { priority = true } = {}) {
    const key = Zotero.isWin ? PathUtils.normalize(root).toLowerCase() : PathUtils.normalize(root);
    if (pending.has(key)) return pending.get(key);
    const p = chain.then(() => {
      pending.delete(key);
      return exportProject(root, { priority });
    });
    pending.set(key, p);
    chain = p.catch(() => {});
    return p;
  }

  function idle() {
    return chain;
  }

  return { run, idle, queue, exportProject, removeOutputs, removeIfUnchanged, wasRendered, ownKey, _hashCache: hashCache };
})();
