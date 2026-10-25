/* global Zsync */
// Citation keys that always work. Every entry zsync writes to the bib gets a
// key that Typst can read and that `@key` cites, used once in the file, and
// the same key annotations.json files the item under:
//   1. the item's own citation key (Zotero's field, which Better BibTeX
//      fills), as it is, when Typst can cite it;
//   2. else that key without the characters Typst cannot cite;
//   3. else one made from the item the way Better BibTeX's default formula
//      makes them (auth.lower + shorttitle(3,3) + year).
// A key already taken gets a, b, ... appended, as Better BibTeX does. Keys
// zsync makes only ever go into its own files, never into Zotero: Better
// BibTeX keeps keys unique across the whole library, zsync can only see one
// collection.
//
// Needs no Zotero, so it can be tested in Node.
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.citekeys = (() => {
  // What Typst 0.15 takes in `@key`: letters, digits, marks and _ (Unicode
  // XID_Continue, as in Typst labels) and "-", with "." or ":" only between
  // them. Anything else either breaks the whole bibliography (whitespace, an
  // empty key, a key used twice) or reads fine but cannot be cited with @
  // (an em dash, "/", "+", "'", a trailing "." ...).
  const CITABLE = /^[\p{XID_Continue}-]+(?:[.:][\p{XID_Continue}-]+)*$/u;

  function isCitable(key) {
    return typeof key === "string" && CITABLE.test(key);
  }

  // A key someone typed, made citable: what Typst cannot cite dropped.
  // "Eby 2010" -> "Eby2010", "smith/2020." -> "smith2020"; "" when nothing is left.
  function repair(key) {
    return String(key || "").normalize("NFC")
      .replace(/[^\p{XID_Continue}\-.:]+/gu, "")
      .replace(/[.:]{2,}/g, (m) => m[0])
      .replace(/^[.:]+|[.:]+$/g, "");
  }

  // Letters without a decomposition, folded the way Better BibTeX does
  const FOLD = { "ß": "ss", "ẞ": "SS", "ø": "o", "Ø": "O", "ł": "l", "Ł": "L", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE",
    "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th", "Þ": "Th", "ı": "i" };

  // "Ångström Øre" -> "Angstrom Ore"; letters with no ASCII form stay as they are
  function ascii(s) {
    return String(s || "").replace(/[ßẞøØłŁæÆœŒđĐðÐþÞı]/g, (c) => FOLD[c])
      .normalize("NFKD").replace(/[̀-ͯ]/g, "");
  }

  // Better BibTeX's default skip words
  const SKIP = new Set(("a,ab,aboard,about,above,across,after,against,al,along,amid,among,an,and,anti,around,as,at,before,"
    + "behind,below,beneath,beside,besides,between,beyond,but,by,d,da,das,de,del,dell,dello,dei,degli,della,dell,delle,dem,den,"
    + "der,des,despite,die,do,down,du,during,ein,eine,einem,einen,einer,eines,el,en,et,except,for,from,gli,i,il,in,inside,into,"
    + "is,l,la,las,le,les,like,lo,los,near,nor,of,off,on,onto,or,over,past,per,plus,round,save,since,so,some,sur,than,the,"
    + "through,to,toward,towards,un,una,unas,under,underneath,une,unlike,uno,unos,until,up,upon,versus,via,von,while,with,"
    + "within,without,yet,zu,zum").split(","));

  // The pieces of Better BibTeX's default formula, each plain ASCII:
  //   auth  the family name of the first creator of the item type's main
  //         kind (author, director, ...), else of the first editor, else
  //         of the first translator, else of the first creator of any other
  //         kind (as Better BibTeX picks them: a creator without a family
  //         name does not count); lower case, "-" kept ("godfrey-smith")
  //   words the title's first three words that are not skip words, each
  //         capitalised; a hyphen joins words, other punctuation splits them
  //   year  the first four-digit year in the date
  // fields: { creators (Zotero creator JSON), primary (the item type's main
  // creator type), title, date, type, itemKey }.
  function parts({ creators = [], primary = "author", title = "", date = "", type = "", itemKey = "" } = {}) {
    const family = (c) => String((c && (c.lastName || c.name)) || "");
    const rank = (c) => (c.creatorType === primary ? 0 : ["editor", "seriesEditor"].includes(c.creatorType) ? 1 : c.creatorType === "translator" ? 2 : 3);
    const first = (creators || []).filter((c) => family(c)).reduce((best, c) => (!best || rank(c) < rank(best) ? c : best), null);
    const name = family(first);
    const auth = ascii(name).replace(/[‐-―−]/g, "-").toLowerCase()
      .replace(/[^a-z0-9-]+/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const words = ascii(String(title || "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/['’`]/g, ""))
      .split(/[^\p{L}\p{N}\p{M}-]+/u)
      .map((w) => w.replace(/^-+|-+$/g, "").replace(/[^A-Za-z0-9]+/g, ""))
      .filter((w) => w && (w.length > 1 || /\d/.test(w)) && !SKIP.has(w.toLowerCase()))
      .slice(0, 3)
      .map((w) => w[0].toUpperCase() + w.slice(1));
    const y = String(date || "").match(/(?<!\d)(\d{4})(?!\d)/);
    const year = y && y[1] !== "0000" ? y[1] : "";
    return { auth, words, year, type: String(type || ""), itemKey: String(itemKey || "") };
  }

  // The key for an item that has none of its own, put together from the
  // pieces above, for example
  //   { auth: "eby", words: ["Trinitite", "Atomic", "Rock"], year: "2010",
  //     type: "journalArticle", itemKey: "8XK2M4PQ" }
  // where auth may be "", words [] and year "" when the item has no author,
  // title or date. Whatever comes back is made citable by generate(), and an
  // empty result falls back to the item key, so this decides only what keys
  // look like, never whether they work.
  // Better BibTeX's default formula, so that a key made here is the one
  // Better BibTeX fills in later (save the a, b, ... it adds for keys used
  // elsewhere in the library): what is missing is left out, and with nothing
  // at all it is zotero-item-<item ID>, here the item key, which unlike the
  // ID is the same on every device.
  function composeKey({ auth, words, year, itemKey }) {
    return (auth + words.join("") + year) || `zotero-item-${itemKey}`;
  }

  // A citable key for any item: never empty, whatever the item holds.
  function generate(fields) {
    let key = "";
    try {
      key = repair(composeKey(parts(fields)));
    }
    catch (e) {
      key = "";
    }
    return key || repair(fields && fields.itemKey) || "zotero";
  }

  // a, b, ..., z, aa, ab, ...
  function suffix(i) {
    let s = "";
    let n = i;
    do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  }

  // a key that still belongs to base: base itself, or base + a suffix
  function fits(key, base) {
    return key === base || (key.startsWith(base) && /^[a-z]+$/.test(key.slice(base.length)));
  }

  // The key of every regular item. items: [{ itemKey, dateAdded, title,
  // stored, generated }], stored being the item's own citation key ("" when
  // it has none) and generated what generate() made for it. prev: item key ->
  // the key zsync gave that item last time, when it was not its own.
  // Keys of their own that Typst can cite come first and stay as they are
  // (of two items with the same one, the one added first keeps it). Then the
  // rest, oldest first: the key they had last time while it still fits,
  // else their repaired or generated key, with a suffix when taken.
  // Returns { keys: Map(item key -> key), warnings }.
  function assign(items, prev = new Map()) {
    const used = new Set();
    const keys = new Map();
    const warnings = [];
    const order = [...items].sort((a, b) => String(a.dateAdded).localeCompare(String(b.dateAdded)) || a.itemKey.localeCompare(b.itemKey));
    const holder = new Map();
    const rest = [];
    for (const it of order) {
      if (it.stored && isCitable(it.stored) && !used.has(it.stored)) {
        used.add(it.stored);
        keys.set(it.itemKey, it.stored);
        holder.set(it.stored, it.itemKey);
      }
      else {
        rest.push(it);
      }
    }
    const baseOf = (it) => (it.stored && repair(it.stored)) || it.generated;
    for (const it of rest) {
      const p = prev.get(it.itemKey);
      if (p && isCitable(p) && !used.has(p) && fits(p, baseOf(it))) {
        used.add(p);
        keys.set(it.itemKey, p);
      }
    }
    for (const it of rest) {
      let key = keys.get(it.itemKey);
      if (!key) {
        const base = baseOf(it);
        key = base;
        for (let i = 0; used.has(key); i++) key = base + suffix(i);
        used.add(key);
        keys.set(it.itemKey, key);
        const p = prev.get(it.itemKey);
        if (p && p !== key) warnings.push(`the citation key of item ${it.itemKey} changed from ${p} to ${key}`);
      }
      const what = `item ${it.itemKey}${it.title ? ` ("${it.title}")` : ""}`;
      if (!it.stored) warnings.push(`${what} has no citation key in Zotero; cite it as @${key} until it has one`);
      else if (!isCitable(it.stored)) warnings.push(`the citation key "${it.stored}" of ${what} cannot be cited in Typst; cite it as @${key}, or change it in Zotero`);
      else warnings.push(`${what} and item ${holder.get(it.stored)} both have the citation key ${it.stored}; cite ${it.itemKey} as @${key}, or give it another key in Zotero`);
    }
    return { keys, warnings };
  }

  // The last check on a whole bibliography: every entry keyed so that Typst
  // reads it and @key cites it, and no key twice. zsync's own steps already
  // see to that; this is for whatever they did not foresee. Returns { text,
  // warnings }, text unchanged when nothing needed changing.
  function checkBib(text) {
    const chunks = Zsync.util.splitBib(text);
    const used = new Set();
    const warnings = [];
    let changed = false;
    for (const c of chunks) {
      if (!c.entry || !c.entry.cited) continue;
      let key = c.entry.key;
      if (isCitable(key) && !used.has(key)) {
        used.add(key);
        continue;
      }
      const base = repair(key) || "entry";
      key = base;
      for (let i = 0; used.has(key); i++) key = base + suffix(i);
      used.add(key);
      warnings.push(`the bibliography had an entry keyed ${JSON.stringify(c.entry.key)}, which Typst cannot use; it is keyed ${key} instead`);
      c.text = Zsync.util.withKey(c.text, key);
      changed = true;
    }
    return { text: changed ? chunks.map((c) => c.text).join("") : text, warnings };
  }

  return { isCitable, repair, ascii, parts, composeKey, generate, suffix, fits, assign, checkBib };
})();
