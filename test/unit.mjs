#!/usr/bin/env node
// Unit tests for zsync's pure functions, run in Node without Zotero:
//   node test/unit.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ TextEncoder, console });
for (const f of ["util", "snapshot", "standalone"]) {
  vm.runInContext(fs.readFileSync(path.join(REPO, "plugin", "content", `${f}.js`), "utf8"), ctx, { filename: `${f}.js` });
}
const { util, snapshot, standalone } = ctx.Zsync;
const plain = (x) => JSON.parse(JSON.stringify(x));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("parseExtra matches the transcript template's rule", () => {
  assert.deepEqual({ ...util.parseExtra("Email-Sent-ISO: 2026-09-21T16:33:12\nOriginal Date: x\nkey:value\n  indented: no\n") },
    { "Email-Sent-ISO": "2026-09-21T16:33:12", key: "value" });
  assert.deepEqual({ ...util.parseExtra("") }, {});
  assert.deepEqual({ ...util.parseExtra(null) }, {});
  assert.deepEqual({ ...util.parseExtra("A: 1\r\nB:2") }, { A: "1", B: "2" });
});

test("isoFromMultipart keeps only the parsed part", () => {
  assert.equal(util.isoFromMultipart("2026-09-17 2026-09-17"), "2026-09-17");
  assert.equal(util.isoFromMultipart("2025-00-00 2025"), "2025");
  assert.equal(util.isoFromMultipart("2025-03-00 March 2025"), "2025-03");
  assert.equal(util.isoFromMultipart("0000-00-00 sometime"), null);
  assert.equal(util.isoFromMultipart(""), null);
});

test("isoFromSQL", () => {
  assert.equal(util.isoFromSQL("2026-09-25 22:58:02"), "2026-09-25T22:58:02Z");
  assert.equal(util.isoFromSQL(""), null);
});

test("stripBibFields removes single-line and multi-line fields only", () => {
  const bib = [
    "@misc{a,",
    "  title = {A {Nested} Title},",
    "  file = {D:\\Papers\\x.pdf},",
    "  note = {line one",
    "    file = {not a field, part of a note}",
    "    line three},",
    "  file = {C:\\a {weird} path\\y.pdf;",
    "    D:\\second.pdf},",
    "  date = {2026}",
    "}",
    "",
    "@article{b,",
    "\tFile = {PDF:C\\:\\\\x.pdf:application/pdf},",
    "\tauthor = {Doe, Jane},",
    "}",
  ].join("\n");
  const out = util.stripBibFields(bib, ["file"]);
  assert.doesNotMatch(out, /^ {2}file\s*=|^\tFile\s*=|second\.pdf/m);
  assert.match(out, /^ {4}file = \{not a field, part of a note\}$/m);
  assert.match(out, /title = \{A \{Nested\} Title\},/);
  assert.match(out, /date = \{2026\}\n\}/);
  assert.match(out, /author = \{Doe, Jane\},\n\}/);
  assert.equal(util.stripBibFields(bib, []), bib);
});

test("stripBibFields handles escaped braces in values", () => {
  const bib = "@misc{a,\n  file = {C:\\\\odd\\{name.pdf},\n  title = {T},\n}\n";
  assert.equal(util.stripBibFields(bib, ["file"]), "@misc{a,\n  title = {T},\n}\n");
});

test("relPath normalises project-relative paths", () => {
  assert.equal(util.relPath("refs\\zsync\\sources"), "refs/zsync/sources");
  assert.equal(util.relPath("/refs//annotations.json"), "refs/annotations.json");
  assert.equal(util.relPath("./refs/./a.json"), "refs/a.json");
});

test("parseSent reads the common mail-client formats", () => {
  const cases = {
    "Monday, 21 September 2026 16:33": "2026-09-21T16:33:00",
    "Thursday, 17 September 2026 7:52 PM": "2026-09-17T19:52:00",
    "Thursday, 17 September 2026 12:05 AM": "2026-09-17T00:05:00",
    "Thursday, 17 September 2026 12:05 PM": "2026-09-17T12:05:00",
    "Monday, September 21, 2026 4:33 PM": "2026-09-21T16:33:00",
    "Monday, September 21, 2026 at 4:33 PM": "2026-09-21T16:33:00",
    "21 September 2026 16:33": "2026-09-21T16:33:00",
    "21/09/2026 4:33 PM": "2026-09-21T16:33:00",
    "Wednesday, 2 Sept 2026 09:05:07": "2026-09-02T09:05:07",
    "Friday, 1 May 2026": "2026-05-01T00:00:00",
  };
  for (const [s, iso] of Object.entries(cases)) assert.equal(snapshot.parseSent(s), iso, s);
  for (const bad of ["", "yesterday", "32 September 2026 10:00", "21 Smarch 2026 10:00", "21 September 2026 25:00"]) {
    assert.equal(snapshot.parseSent(bad), null, bad);
  }
});

const THREAD = [
  "",
  "From: Alex Newman <alex@example.org>",
  "Sent: Monday, 21 September 2026 16:33",
  "To: Sam <sam@example.org>",
  "Subject: RE: Meeting",
  "",
  "Thanks, see you Wednesday.",
  "Kind regards,",
  "",
  "Alex Newman",
  "Housing Coordinator",
  "",
  "From: Robin Oldham <robin@example.org>",
  "Sent: Thursday, 17 September 2026 19:52",
  "To: Sam <sam@example.org>",
  "Subject: Meeting",
  "",
  "Hi Sam,",
  "Bicycles may not be stored in the corridors.",
  "Regards,",
  "Robin Oldham",
].join("\n");

test("headers finds each From/Sent block, newest first", () => {
  const hs = snapshot.headers(THREAD);
  assert.equal(hs.length, 2);
  assert.equal(hs[0].from, "Alex Newman <alex@example.org>");
  assert.equal(hs[1].subject, "Meeting");
});

test("messageAt attributes a highlight to the message above it", () => {
  const pos = THREAD.indexOf("Bicycles may");
  const m = snapshot.messageAt(THREAD, pos);
  assert.equal(m.from, "Robin Oldham <robin@example.org>");
  assert.equal(m["sent-iso"], "2026-09-17T19:52:00");
  assert.equal(m.signoff, "Robin Oldham");
  assert.deepEqual([m.index, m.count], [2, 2]);
  const top = snapshot.messageAt(THREAD, THREAD.indexOf("see you Wednesday"));
  assert.equal(top.signoff, "Alex Newman");
  assert.equal(top.index, 1);
  assert.equal(snapshot.messageAt("no headers here", 3), null);
  assert.equal(snapshot.messageAt(THREAD, 0), null, "before the first header");
});

test("Date: is accepted in place of Sent:", () => {
  const t = "From: A <a@x>\nDate: Monday, 21 September 2026 16:33\nSubject: Hi\n\nBody";
  assert.equal(snapshot.messageAt(t, t.indexOf("Body"))["sent-iso"], "2026-09-21T16:33:00");
});

test("inferFromName reads the date_source_[title]_(id) convention", () => {
  const cases = {
    "2026-09-04_HOUSING_Formal Inspection Notice and Room Safety Action - Level 1_OPTIMISED.pdf":
      { date: "2026-09-04", source: null, title: "HOUSING Formal Inspection Notice and Room Safety Action - Level 1" },
    "2026-09-21-0100_Village Office_Group Chat Screenshots.pdf":
      { date: "2026-09-21T01:00", source: null, title: "Village Office Group Chat Screenshots" },
    "2026-04-16_Main Street Clinic_[ENT - Referral]_(BP2026041655186).pdf":
      { date: "2026-04-16", source: "Main Street Clinic", title: "ENT - Referral" },
    "2023-12-13_[Pathology Report - 13th December 2023]_(getPDFContent).pdf":
      { date: "2023-12-13", source: null, title: "Pathology Report - 13th December 2023" },
    "UNI_Riverside Village 2026_[Resident Handbook 2026]_(document).pdf":
      { date: null, source: "UNI Riverside Village 2026", title: "Resident Handbook 2026" },
    "Minutes_012_final_OPTIMISED-ii.pdf": { date: null, source: null, title: "Minutes 012" },
    "Safety Data Sheet v10.pdf": { date: null, source: null, title: "Safety Data Sheet v10" },
    "Report (1).pdf": { date: null, source: null, title: "Report" },
    "2026-13-40_not a date.pdf": { date: null, source: null, title: "2026-13-40 not a date" },
  };
  for (const [name, want] of Object.entries(cases)) assert.deepEqual(plain(standalone.inferFromName(name)), want, name);
});

test("junk titles and authors are recognised", () => {
  for (const t of ["PDF", "Full Text PDF", "Microsoft Word - draft.docx", "untitled", "scan0001", "IMG_2044", "x", "report.docx"]) {
    assert.ok(standalone.isJunkTitle(t), t);
  }
  for (const t of ["Tenancy Rules Summary", "Resident Handbook 2026"]) assert.ok(!standalone.isJunkTitle(t), t);
  for (const a of ["Administrator", "user", "Microsoft Office User", ""]) assert.ok(standalone.isJunkAuthor(a), a);
  assert.ok(!standalone.isJunkAuthor("Housing Office"));
});

test("pdfDate", () => {
  assert.equal(standalone.pdfDate("D:20250102030405+10'00'"), "2025-01-02");
  assert.equal(standalone.pdfDate("D:2025"), "2025");
  assert.equal(standalone.pdfDate("D:202503"), "2025-03");
  assert.equal(standalone.pdfDate(""), null);
  assert.equal(standalone.pdfDate("garbage"), null);
});

test("describe: overrides, edited titles, file names and PDF metadata, in that order", () => {
  const file = "2026-09-04_HOUSING_Inspection Notice_OPTIMISED.pdf";
  const stem = file.replace(/\.pdf$/, "");
  // file name only
  let d = plain(standalone.describe({ attTitle: stem, filename: file }));
  assert.deepEqual(d, { type: "document", title: "HOUSING Inspection Notice", date: "2026-09-04", creators: [], inferred: { title: "filename", date: "filename" }, titleFallback: false });
  // PDF metadata fills what the name leaves open, never overrides it
  d = plain(standalone.describe({ attTitle: stem, filename: file, pdf: { Title: "Something Else", Author: "Housing Office", CreationDate: "D:20240101" } }));
  assert.equal(d.title, "HOUSING Inspection Notice");
  assert.equal(d.date, "2026-09-04");
  assert.deepEqual(d.creators, [{ name: "Housing Office", role: "author" }]);
  assert.equal(d.inferred.creators, "pdf");
  // a generic name: the PDF's title and date win
  d = plain(standalone.describe({ attTitle: "scan0001", filename: "scan0001.pdf", pdf: { Title: "Tenancy Rules Summary", Author: "Administrator", CreationDate: "D:20250102" } }));
  assert.deepEqual([d.title, d.date, d.creators.length], ["Tenancy Rules Summary", "2025-01-02", 0]);
  assert.deepEqual(d.inferred, { title: "pdf", date: "pdf" });
  // a title typed in Zotero beats the file name
  d = plain(standalone.describe({ attTitle: "Inspection notice for room 12", filename: file }));
  assert.equal(d.title, "Inspection notice for room 12");
  assert.equal(d.inferred.title, "zotero-title");
  assert.equal(d.date, "2026-09-04", "date still from the file name");
  // zsync.json overrides beat everything and are not marked inferred
  d = plain(standalone.describe({ attTitle: stem, filename: file, overrides: { title: "Formal Inspection Notice", author: ["A. Manager", "B. Officer"], date: "2026-09-03" } }));
  assert.deepEqual(d, { type: "document", title: "Formal Inspection Notice", date: "2026-09-03", creators: [{ name: "A. Manager", role: "author" }, { name: "B. Officer", role: "author" }], inferred: {}, titleFallback: false });
});

test("parseLetterDate reads the ways letters write dates", () => {
  const cases = {
    "2026-09-24": "2026-09-24", "24 September 2026": "2026-09-24", "24th Sept 2026": "2026-09-24",
    "September 24, 2026": "2026-09-24", "Sep. 4 2026": "2026-09-04", "24/09/2026": "2026-09-24", "4.9.2026": "2026-09-04",
  };
  for (const [s, iso] of Object.entries(cases)) assert.equal(standalone.parseLetterDate(`Sydney, ${s}\n`), iso, s);
  for (const bad of ["no date here", "32 September 2026", "2026-13-01", "13/13/2026"]) assert.equal(standalone.parseLetterDate(bad), null, bad);
});

test("recogniseLetter: a letter written with a Letter NNN / From / To template", () => {
  // the layout Zotero's text extraction gives for such a letter
  const text = "2026-09-24\nLetter 101 From: Sam Resident\nTo: Village Office\nGood afternoon,\nThis is a request to release my stored items. -Sam\nBibliography\n[1] Something";
  assert.deepEqual(plain(standalone.recogniseLetter(text)), {
    kind: "letter", title: "Letter 101", number: "101", date: "2026-09-24", from: "Sam Resident", to: "Village Office", subject: null,
  });
});

test("recogniseLetter: a formal letter, and a printed email", () => {
  const formal = "Housing Office\n1 Example Street\n21 September 2026\nDear Ms Resident,\nRe: Inspection of room 12\nWe will inspect the room on Friday.\nYours sincerely,\nAlex Manager\nProperty Manager";
  assert.deepEqual(plain(standalone.recogniseLetter(formal)), {
    kind: "letter", title: "Inspection of room 12", number: null, date: "2026-09-21", from: "Alex Manager", to: "Ms Resident", subject: "Inspection of room 12",
  });
  const email = "From: Robin Oldham <robin@example.org>\nSent: Thursday, 17 September 2026 19:52\nTo: Sam Resident <sam@example.org>\nSubject: Bicycle storage\nHi Sam,\nPlease remove the item.\nRegards,\nRobin Oldham";
  assert.deepEqual(plain(standalone.recogniseLetter(email)), {
    kind: "email", title: "Bicycle storage", number: null, date: "2026-09-17T19:52:00", from: "Robin Oldham", to: "Sam Resident", subject: "Bicycle storage",
  });
});

test("recogniseLetter does not call everything a letter", () => {
  // a handbook that greets its readers
  assert.equal(standalone.recogniseLetter("Resident Handbook 2026\nDear residents,\nWelcome to the village. This handbook explains the rules.\n1. Parking\n2. Laundry"), null);
  // a form with From/To fields but nothing else letter-like
  assert.equal(standalone.recogniseLetter("Room transfer form\nFrom: Room 12\nTo: Room 14\nReason:"), null);
  assert.equal(standalone.recogniseLetter(""), null);
});

test("describe: a recognised letter gives type, date, author and recipient", () => {
  const letter = { kind: "letter", title: "Letter 101", number: "101", date: "2026-09-24", from: "Sam Resident", to: "Village Office", subject: null };
  const d = plain(standalone.describe({ attTitle: "Letter_101", filename: "Letter_101.pdf", letter }));
  assert.deepEqual(d, {
    type: "letter", title: "Letter 101", date: "2026-09-24",
    creators: [{ name: "Sam Resident", role: "author" }, { name: "Village Office", role: "recipient" }],
    inferred: { type: "text", title: "text", date: "text", creators: "text", recipients: "text" },
    titleFallback: false,
  });
  assert.equal(standalone.baseCitekey(d), "samresidentLetter1012026", "the recipient is not the author");
  assert.equal(standalone.bibEntry({ ...d, citekey: "k", "date-iso": "2026-09-24" }, "biblatex"),
    "@letter{k,\n  title = {Letter 101},\n  author = {{Sam Resident}},\n  date = {2026-09-24}\n}");
  assert.match(standalone.bibEntry({ ...d, citekey: "k", "date-iso": "2026-09-24" }, "bibtex"), /^@misc\{k,/);
  // zsync.json wins over the text
  const o = plain(standalone.describe({ attTitle: "Letter_101", filename: "Letter_101.pdf", letter, overrides: { type: "document", recipient: "Someone Else" } }));
  assert.equal(o.type, "document");
  assert.deepEqual(o.creators.filter((c) => c.role === "recipient"), [{ name: "Someone Else", role: "recipient" }]);
  assert.equal(o.inferred.recipients, undefined);
});

test("citation keys follow Better BibTeX's auth.lower + shorttitle(3,3) + year", () => {
  assert.equal(standalone.baseCitekey({ creators: [{ name: "Main Street Clinic" }], title: "ENT - Referral", date: "2026-04-16" }), "mainstreetclinicENTReferral2026");
  assert.equal(standalone.baseCitekey({ creators: [], title: "The Resident Handbook of 2026", date: null }), "ResidentHandbook2026");
  assert.equal(standalone.baseCitekey({ creators: [], title: "Café ménu", date: "2025" }), "CafeMenu2025");
  assert.equal(standalone.baseCitekey({ creators: [], title: "", date: null }), "");
});

test("assignCitekeys: overrides first, then oldest file keeps the plain key", () => {
  const { keys, warnings } = standalone.assignCitekeys([
    { attKey: "BBBBBBBB", dateAdded: "2026-01-02 00:00:00", base: "notice2026" },
    { attKey: "AAAAAAAA", dateAdded: "2026-01-01 00:00:00", base: "notice2026" },
    { attKey: "CCCCCCCC", dateAdded: "2026-01-03 00:00:00", base: "taken2026" },
    { attKey: "DDDDDDDD", dateAdded: "2026-01-04 00:00:00", base: "" },
    { attKey: "EEEEEEEE", dateAdded: "2026-01-05 00:00:00", base: "x", override: "mine2026" },
  ], ["taken2026"]);
  assert.deepEqual(Object.fromEntries(keys), {
    EEEEEEEE: "mine2026", AAAAAAAA: "notice2026", BBBBBBBB: "notice2026a", CCCCCCCC: "taken2026a", DDDDDDDD: "docDDDDDDDD",
  });
  assert.deepEqual(plain(warnings), []);
});

test("assignCitekeys: a key stays with its document, and conflicts are reported", () => {
  // a newer document keeps its plain key when an older one with the same base joins
  const docs = [
    { attKey: "NEWWWWWW", dateAdded: "2026-05-01 00:00:00", base: "notice2026" },
    { attKey: "QLDDDDDD", dateAdded: "2026-01-01 00:00:00", base: "notice2026" },
  ];
  let r = standalone.assignCitekeys(docs, [], new Map([["NEWWWWWW", "notice2026"]]));
  assert.deepEqual(Object.fromEntries(r.keys), { NEWWWWWW: "notice2026", QLDDDDDD: "notice2026a" });
  // a previous key that no longer fits the document is replaced, with a warning
  r = standalone.assignCitekeys([{ attKey: "AAAAAAAA", dateAdded: "x", base: "renamed2026" }], [], new Map([["AAAAAAAA", "notice2026"]]));
  assert.equal(r.keys.get("AAAAAAAA"), "renamed2026");
  assert.match(r.warnings[0], /changed from notice2026 to renamed2026/);
  // an override that clashes with a regular item's key
  r = standalone.assignCitekeys([{ attKey: "AAAAAAAA", dateAdded: "x", base: "b", override: "doe2026" }], ["doe2026"]);
  assert.equal(r.keys.get("AAAAAAAA"), "b");
  assert.match(r.warnings[0], /doe2026 set for AAAAAAAA in zsync.json is already used/);
});

test("bibEntry writes a valid, escaped @misc in both styles", () => {
  const item = { citekey: "k2026", title: "Rules {draft} & 50% off #1_a", creators: [{ name: "Housing Office" }, { name: "A \\ B" }], "date-iso": "2026-09-04" };
  assert.equal(standalone.bibEntry(item, "biblatex"), [
    "@misc{k2026,",
    "  title = {Rules \\textbraceleft{}draft\\textbraceright{} \\& 50\\% off \\#1\\_a},",
    "  author = {{Housing Office} and {A \\textbackslash{} B}},",
    "  date = {2026-09-04}",
    "}",
  ].join("\n"));
  assert.equal(standalone.bibEntry({ ...item, creators: [], "date-iso": "2026-09" }, "bibtex"),
    "@misc{k2026,\n  title = {Rules \\textbraceleft{}draft\\textbraceright{} \\& 50\\% off \\#1\\_a},\n  year = {2026},\n  month = sep\n}");
  assert.equal(standalone.bibEntry({ citekey: "bare", title: null, creators: [], "date-iso": null }, "biblatex"), "@misc{bare,\n}");
});

// ---- regressions from the adversarial review

test("letter fields stop at the next header label, and signatures at the name", () => {
  // Zotero joins single-spaced lines; an Outlook header can arrive on one line
  const email = "From: Robin Oldham <robin@example.org> Sent: Thursday, 17 September 2026 19:52 To: Sam Resident <sam@example.org> Subject: Bicycle storage\nHi Sam,\nPlease remove it.\nRegards,\nRobin Oldham";
  const e = plain(standalone.recogniseLetter(email));
  assert.deepEqual([e.kind, e.from, e.to, e.date], ["email", "Robin Oldham", "Sam Resident", "2026-09-17T19:52:00"]);
  const letter = "21 September 2026\nDear Ms Resident,\nWe will inspect the room on Friday.\nYours sincerely,\nAlex Manager, Property Manager | Housing Office";
  assert.equal(standalone.recogniseLetter(letter).from, "Alex Manager");
});

test("the letter date is the first one above the greeting, not a reference number", () => {
  const text = "Our ref: HB-2026-01-02\n21 September 2026\nDear Ms Resident,\nRe: Inspection booked for 2026-10-01\nYours sincerely,\nAlex Manager";
  assert.equal(standalone.recogniseLetter(text).date, "2026-09-21");
  assert.equal(standalone.parseLetterDate("REF-2026-09-24 and then 3 October 2026"), "2026-10-03");
  assert.equal(standalone.parseLetterDate("12/2026/04/01"), null);
});

test("a 'Letter of ...' line is not a heading, and list dashes are not a signature", () => {
  const text = "3 March 2026\nLetter of complaint about parking\nDear Manager,\nPlease note:\n- Cars block the gate\n- Bins are full\nThank you";
  const r = standalone.recogniseLetter(text);
  assert.notEqual(r && r.title, "Letter of complaint about parking".slice(0, 9));
  assert.ok(!r || r.from !== "Bins are full");
});

test("a Zotero title that is really an old file name is not treated as typed", () => {
  assert.equal(standalone.editedTitle("2026-09-04_OLD_Notice_OPTIMISED", "2026-09-05_NEW_[Notice v2].pdf"), null);
  assert.equal(standalone.editedTitle("old_name", "new name.pdf"), null);
  assert.equal(standalone.editedTitle("Inspection notice for room 12", "2026-09-04_X.pdf"), "Inspection notice for room 12");
});

test("account and program names are not authors", () => {
  for (const a of ["Windows User", "HP Authorized Customer", "Valued Customer", "Microsoft account", "Office User", "someone@example.org"]) {
    assert.ok(standalone.isJunkAuthor(a), a);
  }
  assert.ok(standalone.isJunkAuthor("Typst 0.15.1", { Creator: "Typst 0.15.1" }));
  assert.ok(!standalone.isJunkAuthor("Village Office"));
});

test("file-name and PDF dates are validated", () => {
  assert.deepEqual(plain(standalone.inferFromName("2026-09-21 2024 Annual Report.pdf")), { date: "2026-09-21", source: null, title: "2024 Annual Report" });
  assert.equal(standalone.inferFromName("2026-09-21-2599_x.pdf").date, "2026-09-21");
  assert.equal(standalone.inferFromName("2026-02-30_x.pdf").date, null);
  assert.equal(standalone.pdfDate("D:20251399"), "2025");
  assert.equal(standalone.pdfDate("D:20250231"), "2025-02");
  assert.equal(standalone.bibEntry({ citekey: "k", title: "t", creators: [], "date-iso": "2025-13" }, "bibtex"), "@misc{k,\n  title = {t},\n  year = {2025}\n}");
});

test("keys for titles in other scripts and special letters", () => {
  assert.equal(standalone.baseCitekey({ creators: [], title: "Straße Øresund", date: "2026" }), "StrasseOresund2026");
  assert.equal(standalone.baseCitekey({ creators: [], title: "Правила проживания", date: "2026" }), "", "falls back to the attachment key");
  const { keys } = standalone.assignCitekeys([{ attKey: "CYRLLLLL", dateAdded: "x", base: "", year: "2026" }], []);
  assert.equal(keys.get("CYRLLLLL"), "docCYRLLLLL2026");
});

// ---- auto-export, against a fake Zotero

function autoWith({ items = {}, collections = {} } = {}) {
  const fake = vm.createContext({
    TextEncoder, console,
    Zotero: { Items: { get: (id) => items[id] || false }, Collections: { get: (id) => collections[id] || false } },
  });
  for (const f of ["util", "auto"]) {
    vm.runInContext(fs.readFileSync(path.join(REPO, "plugin", "content", `${f}.js`), "utf8"), fake, { filename: `${f}.js` });
  }
  // 99 is a PNG zsync itself just had rendered
  fake.Zsync.exporter = { wasRendered: (id) => id === 99 };
  return fake.Zsync.auto;
}

const fakeItem = (id, { parentID = null, note = false, collections = [], attachmentPath } = {}) =>
  ({ id, libraryID: 1, parentID, attachmentPath, isNote: () => note, getCollections: () => collections });

test("auto-export notices changes under what a project exported, and ignores the rest", () => {
  // collection 10 is the project's, 11 was made inside it since, 12 is elsewhere.
  // Item 1 (in 10) and its attachment 2 were exported; attachment 3 was added
  // to 1 since, and 4 is an annotation on it; 5 is a note on 1, 6 an image in it.
  const items = {
    1: fakeItem(1, { collections: [10] }), 2: fakeItem(2, { parentID: 1, attachmentPath: "storage:a.pdf" }), 3: fakeItem(3, { parentID: 1 }),
    4: fakeItem(4, { parentID: 3 }), 5: fakeItem(5, { parentID: 1, note: true }), 6: fakeItem(6, { parentID: 5 }),
    7: fakeItem(7, { collections: [11] }), 8: fakeItem(8, { collections: [12] }), 99: fakeItem(99, { parentID: 2 }),
  };
  const collections = { 10: { id: 10, parentID: null }, 11: { id: 11, parentID: 10 }, 12: { id: 12, parentID: null } };
  const auto = autoWith({ items, collections });
  const w = (recursive) => ({ libraryID: 1, recursive, collectionIDs: new Set([10]), ids: new Set([1, 2]), keys: new Set(["AAAAAAAA", "BBBBBBBB"]),
    paths: new Map([[2, "storage:a.pdf"]]) });
  const t = (recursive, event, type, ids, extra) => auto.touches(w(recursive), event, type, ids, extra);
  // what an item's own save says (the previous values of what changed)
  const saved = (...ids) => Object.fromEntries(ids.map((id) => [id, { changed: { annotationComment: "before" } }]));
  assert.ok(t(false, "modify", "item", [2], saved(2)), "an exported object");
  assert.ok(t(false, "modify", "item", [1], { 1: {} }), "a parent told that a child was added (it may carry its own edit)");
  assert.ok(t(false, "modify", "item", [2], {}) && t(false, "modify", "item", [2]), "a change announced without details (pages deleted)");
  assert.ok(t(false, "add", "item", [4]), "an annotation on an attachment added since the last export");
  assert.ok(!t(false, "add", "item", [5]) && !t(false, "modify", "item", [5], saved(5)), "a note");
  assert.ok(!t(false, "modify", "item", [6], saved(6)), "an image in a note");
  assert.ok(t(true, "add", "item", [7]) && !t(false, "add", "item", [7]), "an item in a new subcollection, when recursive");
  assert.ok(t(true, "add", "collection-item", ["11-7"]) && !t(false, "add", "collection-item", ["11-7"]));
  assert.ok(t(false, "add", "collection-item", ["10-8"]), "added to the collection");
  assert.ok(t(true, "add", "collection", [11]) && !t(false, "add", "collection", [11]), "a new subcollection, when recursive");
  assert.ok(t(false, "modify", "collection", [10]), "the collection renamed");
  assert.ok(!t(true, "add", "item", [8]) && !t(true, "add", "collection-item", ["12-8"]), "elsewhere");
  assert.ok(t(false, "delete", "item", [42], { 42: { libraryID: 1, key: "BBBBBBBB" } }), "an exported object erased");
  assert.ok(!t(false, "delete", "item", [43], { 43: { libraryID: 1, key: "CCCCCCCC" } }));
  assert.ok(!t(false, "modify", "item", [2], { 2: { changed: {} } }), "a save that changed nothing");
  assert.ok(!t(false, "modify", "item", [99], saved(99)), "zsync's own PNG");
  assert.ok(t(false, "add", "item-tag", ["2-500"]) && !t(false, "add", "item-tag", ["8-500"]), "tags");
  items[2].attachmentPath = "storage:renamed.pdf";
  assert.ok(t(false, "modify", "item", [2], { 2: { changed: {} } }), "its file renamed or relinked (saved with nothing in changed)");
});

// Auto-export switched on for one project folder "R", with timers that are
// recorded but never run, so what gets scheduled can be counted.
async function autoRunning() {
  const timers = [];
  let observer = null;
  const fake = vm.createContext({
    TextEncoder, console,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    IOUtils: { stat: async () => ({ size: 1, lastModified: 1 }), exists: async () => true },
    PathUtils: { join: (...parts) => parts.join("/") },
    Zotero: {
      Items: { get: () => false }, Collections: { get: () => false },
      Prefs: { get: (name) => (name === "extensions.zsync.autoExport" ? true : undefined), registerObserver: () => 1, unregisterObserver() {} },
      Notifier: { registerObserver: (o) => { observer = o; return "zsync"; }, unregisterObserver() {} },
      debug() {}, logError(e) { throw e; },
    },
  });
  for (const f of ["util", "auto"]) {
    vm.runInContext(fs.readFileSync(path.join(REPO, "plugin", "content", `${f}.js`), "utf8"), fake, { filename: `${f}.js` });
  }
  fake.Zsync.exporter = { wasRendered: () => false };
  fake.Zsync.config = { roots: () => ["R"], sameFolder: (a, b) => a === b, projects: async () => [] };
  fake.Zsync.auto.startup();
  // let the first look at zsync.json settle (it only takes note)
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const start = timers.length;
  return { auto: fake.Zsync.auto, notify: (...a) => observer.notify(...a), scheduled: () => timers.length - start };
}

test("something erased while an export was reading it is exported again, once", async () => {
  const { auto, notify, scheduled } = await autoRunning();
  const index = (keys) => ({ libraryID: 1, recursive: false, collectionIDs: [10], ids: [1], keys, paths: [] });
  auto.remember("R", { index: index(["AAAAAAAA"]), ms: 5 });
  // a highlight made since that export, erased while the next export runs
  notify("delete", "item", [50], { 50: { libraryID: 1, key: "HHHHHHHH" } });
  assert.equal(scheduled(), 0, "the watch set it replaces does not know it");
  auto.remember("R", { index: index(["AAAAAAAA", "HHHHHHHH"]), ms: 5 });
  assert.equal(scheduled(), 1, "the export that read it is followed by another");
  auto.remember("R", { index: index(["AAAAAAAA", "HHHHHHHH"]), ms: 5 });
  assert.equal(scheduled(), 1, "only once");
  // another library's object with the same key is not the same object
  notify("delete", "item", [51], { 51: { libraryID: 2, key: "AAAAAAAA" } });
  auto.remember("R", { index: index(["AAAAAAAA"]), ms: 5 });
  assert.equal(scheduled(), 1);
  auto.shutdown();
});

test("the export delay policy always gives a usable delay", () => {
  const auto = autoWith();
  for (const base of [250, 1500, 5000]) {
    for (const lastMs of [null, 0, 40, 800, 20000]) {
      for (const waitedMs of [0, 1000, 9000, 60000, 600000]) {
        const ms = auto.exportDelay({ base, lastMs, waitedMs });
        assert.ok(Number.isFinite(ms) && ms >= 0, JSON.stringify({ base, lastMs, waitedMs, ms }));
      }
    }
  }
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok    ${t.name}`);
  }
  catch (e) {
    failed++;
    console.log(`FAIL  ${t.name}\n      ${String(e.message).split("\n").join("\n      ")}`);
  }
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
