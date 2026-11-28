/* global Zsync */
// File names for the PNGs of image and ink annotations, so that a folder of
// them says where each one came from:
//
//   cao2021_[Unraveling the Structure and Function of Melanin]_p3_Fig-1_2JVIG4TD.png
//   <citation key>_[<short title>]_p<page>_<figure, or the comment's first words>_<annotation key>.png
//
// Everything here works on plain strings, so it can be tested outside Zotero.
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.imagenames = (() => {
  const KINDS = { fig: "Fig", figure: "Fig", table: "Table", plate: "Plate", scheme: "Scheme", chart: "Chart", box: "Box", map: "Map" };
  const KIND = "(fig(?:ure)?|table|plate|scheme|chart|box|map)";
  // "4", "4.9", "S3", "2a", "3-1"
  const NUM = "(S?\\d+(?:[.\\-\\u2013]\\d+)*[A-Za-z]?)";
  const ANYWHERE = new RegExp(`(?:^|[^\\p{L}\\p{N}])${KIND}\\s*\\.?\\s*${NUM}(?![\\p{L}\\p{N}])`, "iu");
  // A caption starts its line, and after its number comes a full stop, colon
  // or dash, the caption's text (a capital), or nothing; a sentence that
  // merely mentions a figure ("Figure 4.9 shows", "Figure 2, which") goes on
  // in lower case or with a comma.
  // (No "i" flag: with it, \p{Lu} would match lower case too.)
  const KIND_CASED = `(${Object.keys(KINDS).map((w) => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}|${w.toUpperCase()}`).join("|")})`;
  const CAPTION = new RegExp(`^\\s*${KIND_CASED}\\s*\\.?\\s*${NUM}(?![\\p{L}\\p{N}]|[.\\-\\u2013]\\d)(?:\\s*[.:|\\u2013\\u2014]|\\s+-\\s|\\s*$|\\s+[\\p{Lu}\\p{N}])`, "u");

  function labelOf(kind, num) {
    return `${KINDS[kind.toLowerCase()]}-${num.replace(/–/g, "-")}`;
  }

  // The figure a comment names ("see Fig. 4.9b" -> "Fig-4.9b"), or null.
  function figureIn(text) {
    const m = ANYWHERE.exec(String(text || ""));
    return m ? labelOf(m[1], m[2]) : null;
  }

  // The captions on a page of text, in reading order, each once.
  function captionsOn(pageText) {
    const out = [];
    for (const line of String(pageText || "").split(/\r?\n/)) {
      const m = CAPTION.exec(line);
      if (!m) continue;
      const label = labelOf(m[1], m[2]);
      if (!out.includes(label)) out.push(label);
    }
    return out;
  }

  // One part of a file name: no characters a file system refuses (Windows is
  // the strictest), no brackets (they mark the title), single spaces.
  function clean(s) {
    return String(s === null || s === undefined ? "" : s).normalize("NFC")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*[\]]+/g, " ")
      .replace(/\s+/g, " ").trim().replace(/^[. ]+|[. ]+$/g, "");
  }

  // At most max characters, cut between words where that keeps most of it.
  function clip(s, max) {
    if (s.length <= max) return s;
    const cut = s.slice(0, max + 1);
    const at = cut.lastIndexOf(" ");
    return (at >= max * 0.6 ? cut.slice(0, at) : s.slice(0, max)).replace(/[\s,;.–—-]+$/, "");
  }

  // The title without its subtitle: "The plumes of Maralinga: Mapping…" ->
  // "The plumes of Maralinga".
  function shortTitle(title, max = 44) {
    const t = clean(String(title || "").split(/:\s|\s[–—]\s|\s-\s|\?\s/)[0]) || clean(title);
    return clip(t, max);
  }

  // The comment's first words, when it names no figure.
  function commentWords(comment, max = 32) {
    const words = clean(String(comment || "").split(/\r?\n/)[0]).replace(/[_]+/g, " ").split(" ").filter(Boolean);
    return clip(words.slice(0, 5).join(" "), max);
  }

  // What the picture shows, as far as zsync can tell: the figure the comment
  // names, else the caption found on its page, else the comment's first
  // words, else "ink" for a drawing.
  function describe({ type, comment, caption }) {
    return figureIn(comment) || caption || commentWords(comment) || (type === "ink" ? "ink" : "");
  }

  // ---- the name itself. This is the one place that decides what a file is
  // called; change the order or the separators here to taste. Each part is
  // already safe for a file name, and any of them except `key` may be "".
  //   citekey  the item's citation key ("cao2021")
  //   title    its short title ("Unraveling the Structure and Function of Melanin")
  //   page     the page label Zotero shows ("3", "iv")
  //   what     see describe() ("Fig-1", "melanin pathways", "ink")
  //   key      the annotation's key, which keeps names unique and lets you
  //            find the picture in annotations.json
  function compose({ citekey, title, page, what, key }) {
    return [
      citekey,
      title && `[${title}]`,
      page && `p${page}`,
      what,
      key,
    ].filter(Boolean).join("_");
  }

  // The file name for one image or ink annotation.
  //   mode "key" gives the plain "<annotation key>.png" of zsync before 0.5.
  function fileName(a, mode = "descriptive") {
    if (mode === "key") return `${a.key}.png`;
    const name = compose({
      citekey: clip(clean(a.citekey), 40),
      title: shortTitle(a.title),
      page: clip(clean(a.page).replace(/\s+/g, ""), 12),
      what: clip(clean(describe(a)), 32),
      key: a.key,
    });
    return `${name.replace(/[. ]+$/, "")}.png`;
  }

  // Names for a whole export, key -> file name. Two that would be the same
  // file (compared as Windows and macOS compare names) get their keys
  // appended, which can only happen when compose leaves the key out.
  function assign(list, mode = "descriptive") {
    const names = new Map(list.map((a) => [a.key, fileName(a, mode)]));
    const fold = (n) => n.normalize("NFC").toLowerCase();
    const count = new Map();
    for (const n of names.values()) count.set(fold(n), (count.get(fold(n)) || 0) + 1);
    for (const [key, n] of names) {
      if (count.get(fold(n)) > 1) names.set(key, `${n.replace(/\.png$/, "")}_${key}.png`);
    }
    return names;
  }

  return { figureIn, captionsOn, clean, clip, shortTitle, commentWords, describe, compose, fileName, assign };
})();
