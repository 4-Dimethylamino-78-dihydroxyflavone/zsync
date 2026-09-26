/* global Zsync, Zotero, IOUtils, PathUtils, setTimeout, clearTimeout */
// Files that sit in a collection without a parent Zotero item: a scanned
// notice, a letter, a safety data sheet. They have no citation key, title,
// date or author in Zotero, so zsync gives each one an item of its own, with
// metadata taken from (in order):
//   1. zsync.json's "documents" overrides for that attachment key
//   2. the attachment's title, when someone edited it in Zotero
//   3. for PDFs, the top of the first page: letters and printed emails
//   4. the file name, read with the convention
//        <date>[-<hhmm>]_<source>_[<title>]_(<id>)<markers>.pdf
//      e.g. "2026-09-04_HOUSING_Notice to Residents_OPTIMISED.pdf"
//   5. the PDF's own metadata (Title, Author, CreationDate)
// Every value that was guessed is listed in the item's "inferred".
//
// Everything above readPdf needs no Zotero, so it can be tested in Node.
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.standalone = (() => {
  // Zotero's own names for attachments whose title says nothing
  const GENERIC_TITLES = new Set(["pdf", "full text pdf", "full text", "snapshot", "attachment", "epub",
    "accepted version", "submitted version", "preprint pdf", "published version"]);
  // Processing marks at the end of a file name: _OPTIMISED, -ii, (1), _REDACTED ...
  const MARKERS = /(?:[\s_-]+(?:optimi[sz]ed|redacted|signed|final|compressed|ocr|ocred|scanned|copy|edited)|-[ivx]{1,4}|\s*\(\d+\))$/i;
  const STOP = new Set(["a", "an", "the", "and", "or", "of", "for", "in", "on", "to", "with", "at", "by", "from",
    "into", "about", "as", "is", "be", "de", "la", "le", "et", "und", "der", "die", "das"]);
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december"];

  function tidy(s) {
    return String(s || "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  }

  function stripMarkers(s) {
    let out = String(s || "").trim();
    for (let i = 0; i < 6; i++) {
      const next = out.replace(MARKERS, "").trim();
      if (next === out || !next) break;
      out = next;
    }
    return out;
  }

  function validYMD(y, m, d) {
    if (!(y >= 1000 && y <= 2999 && m >= 1 && m <= 12)) return false;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return d >= 1 && d <= days;
  }

  // "2026-04-16_Main Street Clinic_[ENT Referral]_(BP123).pdf" ->
  //   { date: "2026-04-16", source: "Main Street Clinic", title: "ENT Referral" }
  // "2026-09-21-0100_Village Office_Group Chat Screenshots_OPTIMISED.pdf" ->
  //   { date: "2026-09-21T01:00", source: null, title: "Village Office Group Chat Screenshots" }
  // A source (author) is only read from the explicit "Source_[Title]" form;
  // without brackets the underscores could be anything, and a wrong author
  // on a piece of evidence is worse than none.
  function inferFromName(name) {
    let rest = String(name || "").replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
    const out = { date: null, source: null, title: null };
    // a time is only taken when it is a valid hhmm and clearly separate
    const d = rest.match(/^(\d{4})-(\d{2})-(\d{2})(?:(?:[-T]|\s(?=\d{4}(?:_|$)))([01]\d|2[0-3])([0-5]\d)(?=[_\s-]|$))?(?:[_\s-]+|$)/);
    if (d && validYMD(+d[1], +d[2], +d[3])) {
      out.date = `${d[1]}-${d[2]}-${d[3]}` + (d[4] ? `T${d[4]}:${d[5]}` : "");
      rest = rest.slice(d[0].length);
    }
    const bracket = rest.match(/\[([^\]]+)\]/);
    if (bracket) {
      out.title = tidy(bracket[1]) || null;
      out.source = tidy(rest.slice(0, bracket.index).replace(/[_\s-]+$/, "")) || null;
      return out;
    }
    out.title = tidy(stripMarkers(rest.replace(/_\([^)]*\)\s*$/, ""))) || null;
    return out;
  }

  function isJunkTitle(t) {
    const s = String(t || "").trim();
    if (s.length < 3) return true;
    if (GENERIC_TITLES.has(s.toLowerCase())) return true;
    return /^(microsoft (word|powerpoint|excel) - |untitled|document\s*\d*$|scan\s*\d*$|img[_-]?\d+$|image\s*\d*$|print\s*$)/i.test(s)
      || /\.(docx?|pptx?|xlsx?|pdf|tmp|indd|odt|rtf|pages)$/i.test(s);
  }

  // Author values that are really account or machine names
  const JUNK_AUTHORS = new Set(["user", "owner", "admin", "administrator", "microsoft office user", "unknown", "author",
    "pdf", "scanner", "default", "guest", "me", "windows user", "office user", "microsoft account", "pc user", "local user",
    "valued customer", "preferred customer", "registered user", "authorized user", "authorised user", "hp authorized customer",
    "hp authorised customer", "dell user", "lenovo user", "acer user", "asus user", "toshiba user", "samsung user", "apple user",
    "standard user", "test", "none", "anonymous", "adobe", "user name", "username", "your name", "name"]);

  function isJunkAuthor(a, pdf = null) {
    if (/^\S+@\S+$/.test(String(a || "").trim())) return true;
    const s = String(a || "").toLowerCase().replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim();
    if (s.length < 2 || JUNK_AUTHORS.has(s)) return true;
    if (/^(hp|dell|lenovo|acer|asus|toshiba|samsung|sony|apple|microsoft|windows|office)\b.*\b(user|customer|owner|account)$/.test(s)) return true;
    // the program that made the PDF, standing in for a person
    const raw = String(a || "").toLowerCase().trim();
    for (const k of ["Creator", "Producer"]) {
      if (pdf && pdf[k] && String(pdf[k]).toLowerCase().trim() === raw) return true;
    }
    return false;
  }

  // PDF date "D:20250102030405+10'00'" -> "2025-01-02" (only as precise as valid)
  function pdfDate(s) {
    const m = String(s || "").match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?/);
    if (!m || !(+m[1] >= 1000)) return null;
    if (!m[2] || !(+m[2] >= 1 && +m[2] <= 12)) return m[1];
    if (!m[3] || !validYMD(+m[1], +m[2], +m[3])) return `${m[1]}-${m[2]}`;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  // ---- letters

  function monthNumber(name) {
    const n = String(name).toLowerCase().replace(/\.$/, "");
    if (n.length < 3) return 0;
    return MONTH_NAMES.findIndex((m) => m.startsWith(n) || (n === "sept" && m === "september")) + 1;
  }

  // The first date in s, by position, as letters write dates: 2026-09-24,
  // 24 September 2026, 24th Sept 2026, September 24, 2026, 24/09/2026 (day
  // first). -> "2026-09-24" or null. Dates inside reference numbers
  // (REF-2026-09-24, 12/2026/04/01) are not taken.
  function parseLetterDate(s) {
    const str = String(s || "");
    const p2 = (x) => String(x).padStart(2, "0");
    const found = [];
    const add = (index, y, m, d) => { if (validYMD(y, m, d)) found.push({ index, iso: `${y}-${p2(m)}-${p2(d)}` }); };
    for (const m of str.matchAll(/(?<![\w/.-])(\d{4})-(\d{2})-(\d{2})(?![\w/.-]*\d)/g)) add(m.index, +m[1], +m[2], +m[3]);
    for (const m of str.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) add(m.index, +m[3], monthNumber(m[2]), +m[1]);
    for (const m of str.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) add(m.index, +m[3], monthNumber(m[1]), +m[2]);
    for (const m of str.matchAll(/(?<![\w/.-])(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?![\w/.-]*\d)/g)) add(m.index, +m[3], +m[2], +m[1]);
    found.sort((a, b) => a.index - b.index);
    return found.length ? found[0].iso : null;
  }

  // "Jane Doe <jane@x.org>", "Jane Doe (jane@x.org)," -> "Jane Doe"
  function cleanName(s) {
    const out = String(s || "").replace(/<[^>]*>|\([^)]*@[^)]*\)|\S+@\S+/g, " ")
      .replace(/\s+/g, " ").replace(/^[\s,;:–—-]+|[\s,;:.–—-]+$/g, "").trim();
    return out.length >= 2 && out.length <= 80 ? out : null;
  }

  // A signature line: the name, without a job title run on after it
  function signerName(line) {
    const cut = String(line || "").split(/\s+[|•·]\s+|\s+[–—-]\s+|,\s+/)[0];
    const words = cut.trim().split(/\s+/);
    if (!words.length || words.length > 6 || !/^[A-Z]/.test(words[0])) return null;
    return cleanName(words.join(" "));
  }

  const HEADER_LABELS = "From|To|Sent|Date|Cc|Bcc|Subject|Re|Importance|Attachments";
  const CLOSING = /^(yours\s+(?:sincerely|faithfully|truly)|kind\s+regards|warm\s+regards|best\s+regards|regards|sincerely|best\s+wishes|many\s+thanks|with\s+thanks|thanks)[,.!]?$/i;
  const SALUTATION = /^(dear\s+([^,:]{2,60})|to\s+whom\s+it\s+may\s+concern|good\s+(?:morning|afternoon|evening|day)|hello|hi)\b/i;

  function field(line, label) {
    const m = line.match(new RegExp(`\\b${label}:\\s*(.+?)(?=\\s+(?:${HEADER_LABELS}):|$)`));
    return m ? m[1].trim() : null;
  }

  // Recognise a letter or a printed email from the text of its first page(s),
  // one visual line per "\n". Returns null, or { kind, title, number, date,
  // from, to, subject } with null for what is unknown. A letter must have a
  // greeting or From:/To: lines near the top.
  function recogniseLetter(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean);
    if (!lines.length) return null;
    const top = lines.slice(0, 30);
    let from = null, to = null, sent = null, emailSubject = null, subject = null, salutationAt = -1, dearName = null;
    for (let i = 0; i < top.length; i++) {
      const l = top[i];
      from = from || field(l, "From");
      to = to || field(l, "To");
      sent = sent || field(l, "Sent") || field(l, "Date");
      emailSubject = emailSubject || field(l, "Subject");
      const r = l.match(/^(?:Re|Subject)\s*:\s*(.{3,200})$/i);
      if (r && !subject) subject = r[1].trim();
      const sal = l.match(SALUTATION);
      if (sal && salutationAt < 0) {
        salutationAt = i;
        dearName = sal[2] ? cleanName(sal[2]) : null;
      }
    }
    if (from && to && sent && emailSubject) {
      const when = Zsync.snapshot ? Zsync.snapshot.parseSent(sent) : null;
      return { kind: "email", title: tidy(emailSubject) || null, number: null, date: when || parseLetterDate(sent),
        from: cleanName(from), to: cleanName(to), subject: tidy(emailSubject) || null };
    }
    const hasHeader = !!(from && to);
    if (salutationAt < 0 && !hasHeader) return null;
    // "Letter 101" at the start of one of the first lines, not "Letter of ..."
    const heading = lines.slice(0, 6).map((l) => l.match(/^Letter\s+(?:No\.?\s*)?(\d{1,4})\b(?!\s+(?:of|to)\b)/)).find(Boolean);
    // the date above the greeting, else the first one near the top
    const date = parseLetterDate((salutationAt >= 0 ? lines.slice(0, salutationAt) : top).join("\n")) || parseLetterDate(top.join("\n"));
    // the signature: the line under a closing, else a "-Name" line, after the greeting
    const body = lines.slice(Math.max(salutationAt, 0) + 1);
    let signer = null;
    for (let i = body.length - 2; i >= 0 && !signer; i--) {
      if (CLOSING.test(body[i])) signer = signerName(body[i + 1]);
    }
    let closing = !!signer;
    if (!signer) {
      for (let i = body.length - 1; i >= 0; i--) {
        const m = body[i].match(/^[–—-][ \t]?([A-Z][a-z'.-]+(?:[ \t][A-Z][A-Za-z'.-]+){0,3})$/);
        const listy = (j) => j >= 0 && j < body.length && /^[–—-]\s/.test(body[j]);
        if (m && !listy(i - 1) && !listy(i + 1)) {
          signer = cleanName(m[1]);
          closing = true;
          break;
        }
      }
    }
    const score = (salutationAt >= 0 ? 2 : 0) + (hasHeader ? 2 : 0) + (heading ? 2 : 0) + (closing ? 2 : 0) + (date ? 1 : 0) + (subject ? 1 : 0);
    if (score < 4) return null;
    return {
      kind: "letter",
      title: heading ? tidy(heading[0]) : (subject ? tidy(subject) : null),
      number: heading ? heading[1] : null,
      date,
      from: (from && cleanName(from)) || signer || null,
      to: (to && cleanName(to)) || dearName,
      subject: subject ? tidy(subject) : null,
    };
  }

  // Zotero title of an attachment, if a person typed it: not the name the
  // file was imported under, and not something that still looks like a file
  // name (Zotero keeps the old name as title when a file is renamed).
  function editedTitle(attTitle, filename) {
    const t = String(attTitle || "").trim();
    if (!t || isJunkTitle(t)) return null;
    const stem = String(filename || "").replace(/\.[A-Za-z0-9]{1,8}$/, "");
    if (t === stem || t === filename) return null;
    if (/[_[\]]/.test(t) || /^\d{4}-\d{2}-\d{2}/.test(t) || MARKERS.test(t) || /\.[A-Za-z0-9]{2,5}$/.test(t)) return null;
    return t;
  }

  // Merge the sources of metadata. overrides: from zsync.json; letter: what
  // recogniseLetter found in the text (or null); pdf: the PDF's Info
  // dictionary (or null). Returns the item fields, "inferred" (where each
  // guessed field came from: "zotero-title", "filename", "text", "pdf"; values
  // from zsync.json are not listed) and titleFallback (true when the title
  // is only the raw file name).
  function describe({ attTitle, filename, overrides = {}, letter = null, pdf = null }) {
    const fromName = inferFromName(filename || attTitle);
    const edited = editedTitle(attTitle, filename);
    const fromEdited = edited ? inferFromName(edited) : null;
    const bracketTitle = /\[[^\]]+\]/.test(String(filename || attTitle || "")) ? fromName.title : null;
    const inferred = {};
    let titleFallback = false;
    const pick = (field, candidates) => {
      for (const [value, source, fallback] of candidates) {
        if (value !== null && value !== undefined && String(value).trim() !== "") {
          if (source !== "zsync.json" && source !== "default") inferred[field] = source;
          if (fallback) titleFallback = true;
          return value;
        }
      }
      return null;
    };
    const type = pick("type", [
      [overrides.type, "zsync.json"],
      [letter && letter.kind, "text"],
      ["document", "default"],
    ]);
    const title = pick("title", [
      [overrides.title, "zsync.json"],
      [edited, "zotero-title"],
      [bracketTitle, "filename"],
      [letter && letter.title, "text"],
      [fromName.title && !isJunkTitle(fromName.title) ? fromName.title : null, "filename"],
      [pdf && !isJunkTitle(pdf.Title) ? tidy(pdf.Title) : null, "pdf"],
      [tidy(String(filename || attTitle || "").replace(/\.[A-Za-z0-9]{1,8}$/, "")), "filename", true],
    ]);
    const date = pick("date", [
      [overrides.date, "zsync.json"],
      [fromEdited && fromEdited.date, "zotero-title"],
      [letter && letter.date, "text"],
      [fromName.date, "filename"],
      [pdf && pdfDate(pdf.CreationDate), "pdf"],
    ]);
    const author = pick("creators", [
      [overrides.author, "zsync.json"],
      [fromName.source, "filename"],
      [letter && letter.from, "text"],
      [pdf && !isJunkAuthor(pdf.Author, pdf) ? tidy(pdf.Author) : null, "pdf"],
    ]);
    const recipient = overrides.recipient || (letter && letter.to) || null;
    if (recipient && !overrides.recipient) inferred.recipients = "text";
    const list = (v) => (v === null || v === undefined ? [] : (Array.isArray(v) ? v : [v]));
    return {
      type,
      title,
      date,
      creators: [
        ...list(author).map((name) => ({ name: String(name), role: "author" })),
        ...list(recipient).map((name) => ({ name: String(name), role: "recipient" })),
      ],
      inferred,
      titleFallback,
    };
  }

  // Letters without a decomposition, folded the way Better BibTeX does
  const FOLD = { "ß": "ss", "ẞ": "SS", "ø": "o", "Ø": "O", "ł": "l", "Ł": "L", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE",
    "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th", "Þ": "Th", "ı": "i" };

  // Better BibTeX-like key: auth.lower + shorttitle(3, 3) + year, or "" when
  // neither an author nor a title word survives (the caller then falls back
  // to one based on the attachment key).
  function baseCitekey({ creators, title, date }) {
    const clean = (s) => String(s || "").replace(/[ßẞøØłŁæÆœŒđĐðÐþÞı]/g, (c) => FOLD[c])
      .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 ]+/g, " ");
    const first = (creators || []).find((c) => !c.role || c.role === "author");
    const auth = first ? clean(first.name).replace(/\s+/g, "").toLowerCase() : "";
    // like Better BibTeX: each word capitalised, the rest kept as written
    const words = clean(title).split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase())).slice(0, 3)
      .map((w) => w[0].toUpperCase() + w.slice(1));
    if (!auth && !words.length) return "";
    const year = (String(date || "").match(/^\d{4}/) || [""])[0];
    return auth + words.join("") + year;
  }

  function suffix(i) {
    let s = "";
    let n = i;
    do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  }

  // Keys for every standalone document, unique among themselves and the
  // collection's real citation keys. docs: [{ attKey, dateAdded, override,
  // base, year }]. prevKeys: attachment key -> key from the last export.
  // A key, once given, stays with its document while it still fits the
  // document's base, so an existing @key never moves to another document.
  // Returns { keys: Map, warnings: [] }.
  function assignCitekeys(docs, taken, prevKeys = new Map()) {
    const used = new Set(taken);
    const keys = new Map();
    const warnings = [];
    const baseOf = (d) => d.base || `doc${d.attKey}${d.year || ""}`;
    for (const d of [...docs].sort((a, b) => a.attKey.localeCompare(b.attKey))) {
      if (!d.override) continue;
      if (used.has(d.override)) {
        warnings.push(`the citation key ${d.override} set for ${d.attKey} in zsync.json is already used; ${d.attKey} gets another key`);
        continue;
      }
      used.add(d.override);
      keys.set(d.attKey, d.override);
    }
    const rest = docs.filter((d) => !keys.has(d.attKey))
      .sort((a, b) => String(a.dateAdded).localeCompare(String(b.dateAdded)) || a.attKey.localeCompare(b.attKey));
    const fits = (key, base) => key === base || (key.startsWith(base) && /^[a-z]+$/.test(key.slice(base.length)));
    for (const d of rest) {
      const prev = prevKeys.get(d.attKey);
      if (prev && !used.has(prev) && fits(prev, baseOf(d))) {
        used.add(prev);
        keys.set(d.attKey, prev);
      }
    }
    for (const d of rest) {
      if (keys.has(d.attKey)) continue;
      const base = baseOf(d);
      let key = base;
      for (let i = 0; used.has(key); i++) key = base + suffix(i);
      used.add(key);
      keys.set(d.attKey, key);
      const prev = prevKeys.get(d.attKey);
      if (prev && prev !== key) warnings.push(`the citation key of ${d.attKey} changed from ${prev} to ${key}`);
    }
    return { keys, warnings };
  }

  const BIB_ESCAPES = { "\\": "\\textbackslash{}", "{": "\\textbraceleft{}", "}": "\\textbraceright{}", "&": "\\&", "%": "\\%",
    "$": "\\$", "#": "\\#", "_": "\\_", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" };

  function bibEscape(s) {
    return String(s).replace(/[\\{}&%$#_~^]/g, (c) => BIB_ESCAPES[c]);
  }

  // One entry: @letter for letters and emails in biblatex (as Better BibTeX
  // writes them), @misc otherwise; biblatex uses date = {...}, bibtex
  // year = {...} and the month macro. Recipients are not a bib field.
  function bibEntry(item, style) {
    const kind = style === "biblatex" && (item.type === "letter" || item.type === "email") ? "letter" : "misc";
    const lines = [`@${kind}{${item.citekey},`];
    const authors = item.creators.filter((c) => !c.role || c.role === "author");
    if (item.title) lines.push(`  title = {${bibEscape(item.title)}},`);
    if (authors.length) lines.push(`  author = {${authors.map((c) => `{${bibEscape(c.name)}}`).join(" and ")}},`);
    const iso = item["date-iso"];
    if (iso) {
      if (style === "biblatex") lines.push(`  date = {${iso}},`);
      else {
        lines.push(`  year = {${iso.slice(0, 4)}},`);
        const month = MONTHS[Number(iso.slice(5, 7)) - 1];
        if (iso.length >= 7 && month) lines.push(`  month = ${month},`);
      }
    }
    if (lines.length > 1) lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, "");
    lines.push("}");
    return lines.join("\n");
  }

  // ---- needs Zotero

  const MAX_PDF_BYTES = 80 * 1024 * 1024;
  const PDF_TIMEOUT = 60 * 1000;
  let cache = null;   // { entries: { "<libraryID>/<key>": { size, mtime, lines, meta } } }
  let cacheDirty = false;

  function cacheFile() {
    return PathUtils.join(Zotero.Profile.dir, "zsync-pdfcache.json");
  }

  async function loadCache() {
    if (cache) return cache;
    try {
      const c = JSON.parse(await IOUtils.readUTF8(cacheFile()));
      cache = c && c.version === 1 && c.entries ? c : { version: 1, entries: {} };
    }
    catch (e) {
      cache = { version: 1, entries: {} };
    }
    return cache;
  }

  async function saveCache() {
    if (!cache || !cacheDirty) return;
    cacheDirty = false;
    try { await IOUtils.writeUTF8(cacheFile(), JSON.stringify(cache), { tmpPath: cacheFile() + ".tmp" }); }
    catch (e) { Zsync.util.log(`could not save the PDF cache: ${e.message}`); }
  }

  // The first two pages' text (one visual line per entry) and the Info
  // dictionary of a PDF, from one call to Zotero's PDF worker. Cached on this
  // device by attachment, file size and modification time, so a restart does
  // not read every PDF again. Returns { lines, meta } or null.
  async function readPdf(att, path) {
    let stat;
    try { stat = await IOUtils.stat(path); }
    catch (e) { return null; }
    const c = await loadCache();
    const id = `${att.libraryID}/${att.key}`;
    const hit = c.entries[id];
    if (hit && hit.size === stat.size && hit.mtime === stat.lastModified) return { lines: hit.lines, meta: hit.meta };
    let result = { lines: [], meta: null };
    if (stat.size <= MAX_PDF_BYTES) {
      let timer;
      try {
        const data = await Promise.race([
          Zotero.PDFWorker.getRecognizerData(att.id, false),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("timed out")), PDF_TIMEOUT); }),
        ]);
        const lines = [];
        for (const page of ((data && data.pages) || []).slice(0, 2)) {
          for (const flow of page[2] || []) for (const block of flow || []) for (const para of block || []) {
            for (const line of para[4] || []) {
              const text = (line[0] || []).map((w) => String(w[13] || "") + (w[5] ? " " : "")).join("").trim();
              if (text) lines.push(text.slice(0, 300));
              if (lines.length >= 200) break;
            }
          }
        }
        result = { lines, meta: (data && data.metadata) || null };
      }
      catch (e) {
        Zsync.util.log(`could not read ${att.key}: ${e.message}`);
      }
      finally {
        clearTimeout(timer);
      }
    }
    c.entries[id] = { size: stat.size, mtime: stat.lastModified, lines: result.lines, meta: result.meta };
    cacheDirty = true;
    return result;
  }

  return {
    inferFromName, isJunkTitle, isJunkAuthor, pdfDate, editedTitle, describe, baseCitekey,
    assignCitekeys, bibEscape, bibEntry, readPdf, saveCache, recogniseLetter, parseLetterDate, validYMD,
  };
})();
