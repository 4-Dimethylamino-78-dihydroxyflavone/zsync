/* global Zsync, Zotero, setTimeout, clearTimeout */
// The bibliography, through Zotero's own export translators: Better BibTeX's
// when it is installed and running, Zotero's built-in ones otherwise.
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.bib = (() => {
  const BUILTIN_BIBLATEX = "b6e39b57-8942-4d11-8259-342c46ce395f";
  // Better BibTeX's translators call into Better BibTeX itself; a copy left
  // behind in the translators folder fails when Better BibTeX is not running.
  const BBT_TRANSLATORS = new Set([
    "f895aa0d-f28e-47fe-b247-2ea77c6ed583", // Better BibLaTeX
    "ca65189f-8815-4afe-8c8b-8c7c15f0edca", // Better BibTeX
    "f4b52ab0-f878-4556-85a0-c7aeedd09dfc", // Better CSL JSON
    "0f238e69-043e-4882-93bf-342de007de19", // Better CSL YAML
    "36a3b0b5-bad0-4a04-b79b-441c7cef77db", // BetterBibTeX JSON
    "8a2f0d30-0b73-4f2c-8b5b-7c1a9e3f2d4e", // Better Hayagriva
  ]);
  const TIMEOUT = 5 * 60 * 1000;  // Better BibTeX queues exports behind its own auto-exports

  function withTimeout(promise, ms, what) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // By translator ID or label (case-insensitive). Falls back to Zotero's
  // built-in BibLaTeX exporter when the wanted one is not usable.
  async function findTranslator(wanted) {
    await Zotero.Translators.init();
    const all = await Zotero.Translators.getAllForType("export");
    const w = String(wanted || "").toLowerCase();
    let hit = all.find((t) => t.translatorID.toLowerCase() === w)
      || all.find((t) => String(t.label).toLowerCase() === w);
    if (hit && BBT_TRANSLATORS.has(hit.translatorID) && !Zotero.BetterBibTeX) hit = null;
    if (hit) return { translatorID: hit.translatorID, label: hit.label, target: hit.target, fallback: false };
    const builtin = all.find((t) => t.translatorID === BUILTIN_BIBLATEX);
    if (!builtin) throw new Error(`export translator "${wanted}" not found, and no built-in BibLaTeX`);
    return { translatorID: builtin.translatorID, label: builtin.label, target: builtin.target, fallback: true };
  }

  // Better BibTeX starts after Zotero; its ready promise never rejects, so
  // give up waiting after a minute rather than hang the export.
  async function betterBibTeXReady() {
    const bbt = Zotero.BetterBibTeX;
    if (bbt && bbt.ready && typeof bbt.ready.then === "function") {
      try { await withTimeout(Promise.resolve(bbt.ready), 60000, "waiting for Better BibTeX"); }
      catch (e) { Zsync.util.log(e.message); }
    }
  }

  async function exportItems(items, wanted) {
    await Zotero.Schema.schemaUpdatePromise;
    await betterBibTeXReady();
    const { translatorID, label, target, fallback } = await findTranslator(wanted);
    // An empty export set makes Better BibTeX throw; an empty bib is right.
    if (!items.length) return { text: "", label, target, fallback };
    const tr = new Zotero.Translate.Export();
    // setItems empties the array it is given, so hand it a copy; pass the
    // translator's ID, not the cached translator object (Better BibTeX
    // mutates its display options)
    tr.setItems(items.slice());
    tr.setTranslator(translatorID);
    let error = null;
    let ok = null;
    tr.setHandler("error", (obj, e) => { error = e || new Error("export failed"); });
    tr.setHandler("done", (obj, success) => { ok = success; });
    const ret = await withTimeout(Promise.resolve(tr.translate()), TIMEOUT, `exporting with ${label}`);
    const text = typeof ret === "string" && ret ? ret : String(tr.string || "");
    if (!text && (error || ok === false)) {
      throw error instanceof Error ? error : new Error(`${label} export failed${error ? `: ${error}` : ""}`);
    }
    return { text, label, target, fallback };
  }

  // Entries for standalone documents (see standalone.js), in the style of the
  // translator's output: biblatex for *BibLaTeX* translators, bibtex otherwise.
  function standaloneEntries(items, label) {
    const style = /biblatex/i.test(label) ? "biblatex" : "bibtex";
    return [...items].sort((a, b) => a.citekey.localeCompare(b.citekey))
      .map((it) => Zsync.standalone.bibEntry(it, style)).join("\n\n");
  }

  // LF line endings, no leading blank lines, one trailing newline; drop fields.
  function finish(text, stripFields) {
    let out = text.replace(/\r\n?/g, "\n");
    out = Zsync.util.stripBibFields(out, stripFields);
    out = out.replace(/^\n+/, "").replace(/\s+$/, "");
    return out ? out + "\n" : "";
  }

  return { findTranslator, exportItems, standaloneEntries, finish, BBT_TRANSLATORS };
})();
