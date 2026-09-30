#!/usr/bin/env node
// End-to-end tests against the isolated Zotero instance (test/zt.mjs) with
// the fixture library (test/seed.mjs). Each test runs JavaScript inside
// Zotero through the dev bridge and checks the files zsync writes.
//
//   node test/zt.mjs start --bbt && node test/fixtures/make-fixtures.mjs && node test/seed.mjs
//   node test/e2e.mjs [filter]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zeval } from "./zt.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = path.join(REPO, ".zt", "projects");
const seeded = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "out", "seeded.json"), "utf8"));
const COLL = seeded.collection.key;
const filter = process.argv[2];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const js = (s) => JSON.stringify(s);
const read = (p) => fs.readFileSync(p, "utf8");
const readJSON = (p) => JSON.parse(read(p));
const exists = (p) => fs.existsSync(p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fresh(name, zsyncJson) {
  const root = path.join(PROJECTS, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  if (zsyncJson) fs.writeFileSync(path.join(root, "zsync.json"), JSON.stringify(zsyncJson, null, 2));
  return root;
}

// run inside Zotero with helpers
function z(body) {
  return zeval(`
    const lib = Zotero.Libraries.userLibraryID;
    const byKey = (k) => Zotero.Items.getByLibraryAndKey(lib, k);
    const coll = Zotero.Collections.getByLibraryAndKey(lib, ${js(COLL)});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    ${body}
  `);
}

const exportProject = (root) => z(`const r = await Zotero.Zsync.exportProject(${js(root)}); delete r.index; return r;`);

// ---------------------------------------------------------------- tests
test("link creates zsync.json and registers the folder", async () => {
  const root = fresh("link");
  const cfg = await z(`const c = await Zotero.Zsync.link(coll, ${js(root)}); return { collection: c.collection, library: c.library, roots: Zotero.Zsync.roots() };`);
  assert.equal(cfg.collection, COLL);
  assert.equal(cfg.library, "user");
  assert.ok(cfg.roots.some((r) => r.toLowerCase() === root.toLowerCase()));
  const written = readJSON(path.join(root, "zsync.json"));
  assert.equal(written.collection, COLL);
  assert.equal(written.name, "zsync fixture");
});

test("export writes every output, and a second export changes nothing", async () => {
  const root = fresh("basic", { zsync: 1, collection: COLL });
  const r1 = await exportProject(root);
  for (const f of ["refs/annotations.json", "refs/zsync.bib", "refs/zsync/manifest.json"]) {
    assert.ok(r1.changed.includes(f), `${f} written`);
    assert.ok(exists(path.join(root, f)));
  }
  const r2 = await exportProject(root);
  assert.deepEqual(r2.changed, [], "idempotent");
  assert.deepEqual(r2.removed, []);
});

test("annotations.json follows docs/SCHEMA.md", async () => {
  const root = fresh("schema", { zsync: 1, collection: COLL });
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  assert.equal(d.zsync, 1);
  assert.equal(d.collection.key, COLL);
  assert.deepEqual(Object.keys(d), ["zsync", "collection", "items", "attachments", "annotations", "warnings"]);
  // items keyed by citation key, sorted
  const keys = Object.keys(d.items);
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(d.items.doe2026normal && d.items.newman2026meeting);
  assert.ok(!d.items.sub2026only, "subcollection item excluded when not recursive");
  const it = d.items.doe2026normal;
  assert.equal(it.citekey, "doe2026normal");
  assert.equal(it.type, "document");
  assert.equal(it["date-iso"], "2026-09-17");
  assert.deepEqual(it.creators, [{ name: "Jane Doe", role: "author" }]);
  assert.equal(it.extra["Email-Sent-ISO"], "2026-09-17T19:52:00");
  assert.match(it.select, /^zotero:\/\/select\/library\/items\/[A-Z0-9]{8}$/);
  assert.equal(d.items.roe2025rotated["date-iso"], "2025");
  assert.equal(d.items.newman2026meeting.title, "RE: [EXTERNAL] Meeting - Room inspection");
  // annotations
  const hl = d.annotations.HLNRMAAA;
  assert.equal(hl.type, "highlight");
  assert.equal(hl.citekey, "doe2026normal");
  assert.equal(hl.text, "Residents must not store bicycles in corridors.");
  assert.deepEqual(hl.tags, ["evidence"]);
  assert.equal(hl["page-index"], 0);
  assert.equal(hl.page, "1");
  assert.equal(hl.rects.length, 1);
  assert.match(hl.link, /^zotero:\/\/open\/library\/items\/[A-Z0-9]{8}\?annotation=HLNRMAAA$/);
  assert.match(hl.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(d.annotations.HLSPANAA["next-page-rects"].length, 1);
  assert.equal(d.annotations.NTNRMAAA.text, null);
  assert.equal(d.annotations.NTNRMAAA.comment, "a sticky note");
  // reading order within the item
  const order = it.annotations;
  const sorts = order.map((k) => d.annotations[k].sort);
  assert.deepEqual(sorts, [...sorts].sort());
  // every item has the same shape
  for (const [k, item] of Object.entries(d.items)) {
    assert.equal(typeof item.standalone, "boolean", k);
    assert.equal(typeof item.inferred, "object", k);
  }
  assert.equal(d.items.doe2026normal.standalone, false);
  // a standalone file is an item of its own
  const lone = Object.values(d.attachments).find((a) => a.annotations.includes("HLLNEAAA"));
  assert.equal(lone.item, lone.key);
  assert.equal(d.annotations.HLLNEAAA.citekey, lone.citekey);
  assert.equal(d.items[lone.citekey].standalone, true);
  assert.deepEqual(d.items[lone.citekey].attachments, [lone.key]);
});

const standaloneKey = (file) => seeded.made.find((m) => m.file === file).key;
const fixtureFile = (name) => JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "out", "fixtures.json"), "utf8"))[name].file;

test("standalone files become items, with metadata from the file name and the PDF", async () => {
  const root = fresh("standalone", { zsync: 1, collection: COLL });
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  const byAtt = (file) => Object.values(d.items).find((it) => it.key === standaloneKey(file));
  const notice = byAtt(fixtureFile("notice"));
  assert.deepEqual({ citekey: notice.citekey, title: notice.title, date: notice.date, iso: notice["date-iso"], creators: notice.creators, inferred: notice.inferred, type: notice.type }, {
    citekey: "HOUSINGInspectionNotice2026", title: "HOUSING Inspection Notice for Room 12", date: "2026-09-04", iso: "2026-09-04",
    creators: [], inferred: { title: "filename", date: "filename" }, type: "document",
  });
  const handbook = byAtt(fixtureFile("handbook"));
  assert.equal(handbook.title, "Resident Handbook 2026");
  assert.deepEqual(handbook.creators, [{ name: "UNI Riverside Village 2026", role: "author" }]);
  assert.equal(handbook.inferred.creators, "filename");
  const scan = byAtt(fixtureFile("scan"));
  assert.deepEqual({ title: scan.title, date: scan.date, creators: scan.creators, inferred: scan.inferred, citekey: scan.citekey }, {
    title: "Tenancy Rules Summary", date: "2025-01-02", creators: [{ name: "Housing Office", role: "author" }],
    inferred: { title: "pdf", date: "pdf", creators: "pdf" }, citekey: "housingofficeTenancyRulesSummary2025",
  });
  // highlights point at them
  assert.equal(d.annotations.HLNTCAAA.citekey, "HOUSINGInspectionNotice2026");
  assert.equal(d.annotations.HLNTCAAA.item, notice.key);
  assert.match(notice.select, /^zotero:\/\/select\/library\/items\/[A-Z0-9]{8}$/);
});

test("letters and printed emails are recognised from their text", async () => {
  const root = fresh("letters", { zsync: 1, collection: COLL });
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  const byAtt = (file) => Object.values(d.items).find((it) => it.key === standaloneKey(file));
  const pick = (it) => ({ citekey: it.citekey, type: it.type, title: it.title, date: it.date, creators: it.creators, inferred: it.inferred });
  assert.deepEqual(pick(byAtt(fixtureFile("letter"))), {
    citekey: "samresidentLetter1012026", type: "letter", title: "Letter 101", date: "2026-09-24",
    creators: [{ name: "Sam Resident", role: "author" }, { name: "Village Office", role: "recipient" }],
    inferred: { type: "text", title: "text", date: "text", creators: "text", recipients: "text" },
  });
  const formal = byAtt(fixtureFile("formalLetter"));
  assert.deepEqual([formal.type, formal.title, formal.date], ["letter", "Inspection of room 12", "2026-09-21"]);
  assert.deepEqual(formal.creators, [{ name: "Alex Manager", role: "author" }, { name: "Ms Resident", role: "recipient" }]);
  const email = byAtt(fixtureFile("printedEmail"));
  assert.deepEqual([email.type, email.title, email.date], ["email", "Bicycle storage", "2026-09-17T19:52:00"]);
  assert.equal(email["date-iso"], "2026-09-17");
  // not letters
  assert.equal(byAtt(fixtureFile("handbook")).type, "document");
  assert.equal(byAtt(fixtureFile("scan")).type, "document");
  // biblatex @letter entries
  const bib = read(path.join(root, "refs/zsync.bib"));
  assert.match(bib, /@letter\{samresidentLetter1012026,\n {2}title = \{Letter 101\},\n {2}author = \{\{Sam Resident\}\},\n {2}date = \{2026-09-24\}\n\}/);
  assert.match(bib, new RegExp(`@letter\\{${email.citekey},`));
});

test("standalone documents get bib entries that Typst can cite", async () => {
  const root = fresh("standalone-bib", { zsync: 1, collection: COLL });
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  const bib = read(path.join(root, "refs/zsync.bib"));
  const docs = Object.values(d.items).filter((it) => it.standalone);
  assert.ok(docs.length >= 4);
  for (const it of docs) assert.match(bib, new RegExp(`@(misc|letter)\\{${it.citekey},`), it.citekey);
  assert.match(bib, /@misc\{HOUSINGInspectionNotice2026,\n {2}title = \{HOUSING Inspection Notice for Room 12\},\n {2}date = \{2026-09-04\}\n\}/);
  // the real test: Typst reads the file and every key resolves
  const cites = [...docs.map((it) => it.citekey), "doe2026normal"].map((k) => `@${k}`).join(" ");
  fs.writeFileSync(path.join(root, "cite.typ"), `${cites}\n#bibliography("refs/zsync.bib")\n`);
  const { execFileSync } = await import("node:child_process");
  execFileSync("typst", ["compile", "cite.typ", "cite.pdf"], { cwd: root, stdio: "pipe" });
  assert.ok(exists(path.join(root, "cite.pdf")));
});

test("zsync.json documents override the guesses", async () => {
  const key = standaloneKey(fixtureFile("notice"));
  const root = fresh("documents", { zsync: 1, collection: COLL, documents: { [key]: { citekey: "notice2026", title: "Formal Inspection Notice", author: "Housing Office", date: "2026-09-03" } } });
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  assert.deepEqual({ ...d.items.notice2026, attachments: undefined, annotations: undefined, select: undefined, tags: undefined }, {
    key, citekey: "notice2026", type: "document", title: "Formal Inspection Notice", "short-title": null, date: "2026-09-03", "date-iso": "2026-09-03",
    url: null, creators: [{ name: "Housing Office", role: "author" }], extra: {}, standalone: true, inferred: {},
    attachments: undefined, annotations: undefined, select: undefined, tags: undefined,
  });
  assert.equal(d.annotations.HLNTCAAA.citekey, "notice2026");
  assert.match(read(path.join(root, "refs/zsync.bib")), /@misc\{notice2026,\n {2}title = \{Formal Inspection Notice\},\n {2}author = \{\{Housing Office\}\},\n {2}date = \{2026-09-03\}\n\}/);
  // bad overrides are rejected
  const bad = fresh("documents-bad", { zsync: 1, collection: COLL, documents: { [key]: { year: "2026" } } });
  await assert.rejects(exportProject(bad), /not one of citekey, title, date, author/);
});

test("standalone: attachments keeps files out of items and the bib", async () => {
  const root = fresh("standalone-off", { zsync: 1, collection: COLL, standalone: "attachments" });
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  assert.ok(Object.values(d.items).every((it) => !it.standalone));
  assert.equal(d.annotations.HLNTCAAA.citekey, null);
  assert.equal(d.annotations.HLNTCAAA.item, null);
  assert.doesNotMatch(read(path.join(root, "refs/zsync.bib")), /@misc\{HOUSINGInspectionNotice2026/);
});

test("email highlight is placed in the quoted message that holds it", async () => {
  const root = fresh("mail", { zsync: 1, collection: COLL });
  await exportProject(root);
  const m = readJSON(path.join(root, "refs/annotations.json")).annotations.HLMAILAA.message;
  assert.equal(m.from, "Robin Oldham <robin.oldham@example.org>");
  assert.equal(m["sent-iso"], "2026-09-17T19:52:00");
  assert.equal(m.signoff, "Robin Oldham");
  assert.equal(m.subject, "[EXTERNAL] Meeting - Room inspection");
  assert.deepEqual([m.index, m.count], [2, 2]);
});

test("recursive includes subcollection items", async () => {
  const root = fresh("recursive", { zsync: 1, collection: COLL, recursive: true });
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  assert.ok(d.items.sub2026only);
  assert.ok(d.annotations.HLSUBAAA);
});

test("missing file is a warning, not a failure", async () => {
  const root = fresh("missing", { zsync: 1, collection: COLL });
  const r = await exportProject(root);
  assert.ok(r.warnings.some((w) => /not on this device/.test(w)));
  const d = readJSON(path.join(root, "refs/annotations.json"));
  assert.ok(d.items.gone2026missing);
  assert.ok(d.warnings.some((w) => /not on this device/.test(w)));
});

test("bib: Better BibLaTeX, no file fields, only direct items", async () => {
  const root = fresh("bib", { zsync: 1, collection: COLL });
  await exportProject(root);
  const bib = read(path.join(root, "refs/zsync.bib"));
  assert.match(bib, /@\w+\{doe2026normal,/);
  assert.match(bib, /@\w+\{newman2026meeting,/);
  assert.doesNotMatch(bib, /^\s*file\s*=/m, "file field stripped");
  assert.doesNotMatch(bib, /sub2026only/);
  assert.doesNotMatch(bib, /\r/);
  const m = readJSON(path.join(root, "refs/zsync/manifest.json"));
  assert.equal(m.bib.translator, "Better BibLaTeX");
});

test("bib: built-in BibLaTeX by label, and bib: null skips it", async () => {
  const root = fresh("bib2", { zsync: 1, collection: COLL, bibTranslator: "BibLaTeX", bib: "out/refs.bib" });
  await exportProject(root);
  const bib = read(path.join(root, "out/refs.bib"));
  assert.match(bib, /@\w+\{doe2026normal,/);
  assert.doesNotMatch(bib, /^\s*file\s*=/m);
  const root2 = fresh("nobib", { zsync: 1, collection: COLL, bib: null });
  const r = await exportProject(root2);
  assert.ok(!exists(path.join(root2, "refs/zsync.bib")));
  assert.ok(!r.changed.some((f) => f.endsWith(".bib")));
});

test("unknown translator falls back to built-in BibLaTeX with a warning", async () => {
  const root = fresh("bib3", { zsync: 1, collection: COLL, bibTranslator: "No Such Exporter" });
  const r = await exportProject(root);
  assert.ok(r.warnings.some((w) => /not installed/.test(w)));
  assert.match(read(path.join(root, "refs/zsync.bib")), /doe2026normal/);
});

test("copySources: annotated copies only annotated files, none copies nothing", async () => {
  const root = fresh("src", { zsync: 1, collection: COLL });
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  const copied = Object.values(d.attachments).filter((a) => a.file);
  assert.ok(copied.length >= 5);
  for (const a of copied) {
    assert.ok(a.annotations.length > 0);
    assert.ok(exists(path.join(root, a.file)), a.file);
  }
  const m = readJSON(path.join(root, "refs/zsync/manifest.json"));
  for (const [k, s] of Object.entries(m.sources)) assert.match(s.sha256, /^[0-9a-f]{64}$/, k);
  // switching to none removes the copies zsync made
  fs.writeFileSync(path.join(root, "zsync.json"), JSON.stringify({ zsync: 1, collection: COLL, copySources: "none" }));
  const r = await exportProject(root);
  assert.ok(r.removed.length >= 5);
  for (const a of copied) assert.ok(!exists(path.join(root, a.file)));
});

test("a copy damaged outside zsync is repaired", async () => {
  const root = fresh("repair", { zsync: 1, collection: COLL });
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  const f = path.join(root, Object.values(d.attachments).find((a) => a.file).file);
  fs.writeFileSync(f, "garbage");
  const r = await exportProject(root);
  assert.ok(r.changed.some((c) => f.replaceAll("\\", "/").endsWith(c)));
  assert.notEqual(read(f), "garbage");
});

test("image and ink annotations get PNGs, rendered without the reader", async () => {
  const root = fresh("img", { zsync: 1, collection: COLL });
  await z(`for (const k of ["IMNRMAAA", "INNRMAAA"]) await Zotero.Annotations.removeCacheImage(byKey(k)); return true;`);
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  for (const k of ["IMNRMAAA", "INNRMAAA"]) {
    const img = d.annotations[k].image;
    assert.equal(img, `refs/zsync/images/${k}.png`);
    const buf = fs.readFileSync(path.join(root, img));
    assert.equal(buf.subarray(1, 4).toString(), "PNG");
  }
  assert.equal(d.annotations.HLNRMAAA.image, null);
  // renderImages: false removes them
  fs.writeFileSync(path.join(root, "zsync.json"), JSON.stringify({ zsync: 1, collection: COLL, renderImages: false }));
  const r = await exportProject(root);
  assert.ok(r.removed.some((f) => f.endsWith("IMNRMAAA.png")));
  assert.equal(readJSON(path.join(root, "refs/annotations.json")).annotations.IMNRMAAA.image, null);
});

test("bad zsync.json values are rejected with a clear message", async () => {
  const cases = [
    [{ zsync: 1 }, /collection/],
    [{ zsync: 2, collection: COLL }, /version/],
    [{ zsync: 1, collection: COLL, annotations: "../outside.json" }, /inside the project/],
    [{ zsync: 1, collection: COLL, annotations: "C:/elsewhere/a.json" }, /inside the project/],
    [{ zsync: 1, collection: COLL, copySources: "some" }, /copySources/],
    [{ zsync: 1, collection: "NOTAKEY0" }, /collection/],
    [{ zsync: 1, collection: "ZZZZZZZZ" }, /not found/],
  ];
  for (const [cfg, re] of cases) {
    const root = fresh("bad", cfg);
    await assert.rejects(exportProject(root), re, JSON.stringify(cfg));
  }
  const root = fresh("badjson");
  fs.writeFileSync(path.join(root, "zsync.json"), "{ not json");
  await assert.rejects(exportProject(root), /not valid JSON/);
});

test("stale files zsync never wrote are left alone", async () => {
  const root = fresh("foreign", { zsync: 1, collection: COLL });
  fs.mkdirSync(path.join(root, "refs/zsync/sources"), { recursive: true });
  fs.writeFileSync(path.join(root, "refs/zsync/sources/mine.pdf"), "user file");
  await exportProject(root);
  fs.writeFileSync(path.join(root, "zsync.json"), JSON.stringify({ zsync: 1, collection: COLL, copySources: "none" }));
  await exportProject(root);
  assert.equal(read(path.join(root, "refs/zsync/sources/mine.pdf")), "user file");
});

test("concurrent export requests are coalesced and serialised", async () => {
  const a = fresh("concurrent-a", { zsync: 1, collection: COLL });
  const b = fresh("concurrent-b", { zsync: 1, collection: COLL });
  const out = await z(`
    const order = [];
    const track = (name, p) => p.then((r) => { order.push(name); return r; });
    // four requests for one folder while nothing has started: one export serves them all
    const same = [1, 2, 3, 4].map(() => track("a", Zotero.Zsync.exportProject(${js(a)})));
    // a second folder queues behind it
    const other = track("b", Zotero.Zsync.exportProject(${js(b)}));
    const rs = await Promise.all([...same, other]);
    return { sameReport: rs.slice(0, 4).every((r) => r === rs[0]), changedA: rs[0].changed.length, changedB: rs[4].changed.length, order };
  `);
  assert.equal(out.sameReport, true);
  assert.ok(out.changedA > 0 && out.changedB > 0);
  assert.deepEqual(out.order, ["a", "a", "a", "a", "b"]);
  for (const root of [a, b]) {
    assert.ok(!fs.readdirSync(path.join(root, "refs")).some((f) => f.includes("zsync-tmp")));
  }
});

test("auto-export follows edits, additions, deletions and membership, not unrelated changes", async () => {
  const root = fresh("auto", { zsync: 1, collection: COLL });
  const file = path.join(root, "refs/annotations.json");
  const out = await z(`
    const before = Zotero.Zsync.roots();
    for (const r of before) Zotero.Zsync.removeRoot(r);
    Zotero.Zsync.addRoot(${js(root)});
    Zotero.Prefs.set("extensions.zsync.debounceMs", 1000, true);
    Zotero.Prefs.set("extensions.zsync.autoExport", true, true);
    try {
      await wait(4000);
      const read = async () => JSON.parse(await IOUtils.readUTF8(${js(file)}));
      const o = {};
      const hl = byKey("HLNRMAAA");
      const stamp = "e2e " + Date.now();
      hl.annotationComment = stamp;
      await hl.saveTx();
      await wait(3000);
      o.modify = (await read()).annotations.HLNRMAAA.comment === stamp;
      const att = byKey(${js(seeded.made[1].attachment.key)});
      await Zotero.Annotations.saveFromJSON(att, { key: "EETESTAA", type: "highlight", text: "e2e added", color: "#ffd400", pageLabel: "1", sortIndex: "00000|000009|00009", position: { pageIndex: 0, rects: [[72, 600, 120, 612]] } });
      await wait(3000);
      o.add = !!(await read()).annotations.EETESTAA;
      await byKey("EETESTAA").eraseTx();
      await wait(3000);
      o.erase = !(await read()).annotations.EETESTAA;
      const item = byKey(${js(seeded.made[2].key)});
      item.removeFromCollection(coll.id); await item.saveTx();
      await wait(3000);
      o.removed = !(await read()).items.crop2024box;
      item.addToCollection(coll.id); await item.saveTx();
      await wait(3000);
      o.readded = !!(await read()).items.crop2024box;
      // no export at all (an unchanged file would not show one)
      const lastAt = () => Zotero.Zsync.lastResult(${js(root)}).at;
      let at = lastAt();
      const other = new Zotero.Item("book"); other.setField("title", "unrelated"); await other.saveTx();
      await wait(2500);
      o.unrelatedIgnored = lastAt() === at;
      await other.eraseTx();
      // notes are not exported, and one being written saves every few
      // seconds (a new one tells its parent, which may export once)
      const note = new Zotero.Item("note"); note.parentID = byKey(${js(seeded.made[0].key)}).id; note.setNote("<p>e2e note</p>"); await note.saveTx();
      await wait(2500);
      at = lastAt();
      note.setNote("<p>e2e note, edited</p>"); await note.saveTx();
      note.setNote("<p>e2e note, edited again</p>"); await note.saveTx();
      await wait(2500);
      o.noteIgnored = lastAt() === at;
      await note.eraseTx();
      return o;
    }
    finally {
      Zotero.Prefs.set("extensions.zsync.autoExport", false, true);
      Zotero.Zsync.removeRoot(${js(root)});
      for (const r of before) Zotero.Zsync.addRoot(r);
    }
  `);
  assert.deepEqual(out, { modify: true, add: true, erase: true, removed: true, readded: true, unrelatedIgnored: true, noteIgnored: true });
});

// ---- automatic export: watch only `roots`, with a short wait, until autoOff
async function autoOn(roots, debounceMs = 500) {
  return z(`
    const saved = Zotero.Zsync.roots();
    for (const r of saved) Zotero.Zsync.removeRoot(r);
    for (const r of ${js(roots)}) Zotero.Zsync.addRoot(r);
    Zotero.Prefs.set("extensions.zsync.debounceMs", ${debounceMs}, true);
    Zotero.Prefs.set("extensions.zsync.autoExport", true, true);
    return saved;
  `);
}

async function autoOff(saved, roots) {
  await z(`
    Zotero.Prefs.set("extensions.zsync.autoExport", false, true);
    Zotero.Prefs.clear("extensions.zsync.debounceMs", true);
    for (const r of ${js(roots)}) Zotero.Zsync.removeRoot(r);
    for (const r of ${js(saved)}) Zotero.Zsync.addRoot(r);
    return true;
  `);
}

// Wait until fn() gives something truthy (fn may be async, or throw meanwhile)
async function waitFor(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    }
    catch {}
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const lastResult = (root) => z(`const r = Zotero.Zsync.lastResult(${js(root)}); return r && { ...r, report: r.report && { ...r.report, index: undefined } };`);

// Windows refuses to rename a folder while anything has a file in it open
async function rename(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); }
    catch (e) { if (i >= 10) throw e; await sleep(300); }
  }
}

test("auto-export is on by default", async () => {
  assert.equal(await z(`return Services.prefs.getDefaultBranch("").getBoolPref("extensions.zsync.autoExport");`), true);
});

test("auto-export follows zsync.json edits, reports mistakes, and picks a folder back up", async () => {
  const root = fresh("auto-config", { zsync: 1, collection: COLL });
  const ann = path.join(root, "refs", "annotations.json");
  const config = (extra) => fs.writeFileSync(path.join(root, "zsync.json"), JSON.stringify({ zsync: 1, collection: COLL, ...extra }));
  const saved = await autoOn([root]);
  try {
    await waitFor(() => exists(ann) && !readJSON(ann).items.sub2026only, "the first export");
    // an edit to zsync.json is exported without asking
    config({ recursive: true });
    await waitFor(() => readJSON(ann).items.sub2026only, "the zsync.json edit");
    // a mistake is recorded as an automatic export's error; fixing it recovers
    fs.writeFileSync(path.join(root, "zsync.json"), "{ not json");
    const bad = await waitFor(async () => { const r = await lastResult(root); return r && /not valid JSON/.test(r.error || "") && r; }, "the error");
    assert.equal(bad.auto, true);
    const fixedAt = Date.now();
    config({});
    // the whole export, not just annotations.json: its manifest comes after,
    // and Windows cannot rename a folder zsync is still writing into
    await waitFor(async () => {
      const r = await lastResult(root);
      return r && !r.error && Date.parse(r.at) >= fixedAt && !readJSON(ann).items.sub2026only;
    }, "the fixed zsync.json");
    // the folder goes away (a drive unplugged) and comes back
    const away = `${root}-away`;
    fs.rmSync(away, { recursive: true, force: true });
    await rename(root, away);
    fs.rmSync(path.join(away, "refs", "annotations.json"));
    await sleep(3000);
    await rename(away, root);
    await waitFor(() => exists(ann), "the folder coming back");
  }
  finally {
    await autoOff(saved, [root]);
  }
});

test("automatic exports reuse the bibliography unless an item changed", async () => {
  const root = fresh("auto-bib", { zsync: 1, collection: COLL });
  const ann = path.join(root, "refs", "annotations.json");
  const bib = path.join(root, "refs", "zsync.bib");
  const itemKey = seeded.made[0].key;
  const title = await z(`return byKey(${js(itemKey)}).getField("title");`);
  // the first automatic export that finished at or after t
  const doneAfter = (t) => waitFor(async () => {
    const r = await lastResult(root);
    return r && r.auto && r.report && Date.parse(r.at) >= t && r;
  }, "an automatic export");
  // long enough that the two title saves below (600 ms apart) make one export
  const saved = await autoOn([root], 1500);
  try {
    await doneAfter(0);
    // an annotation changed: exported, without running the translator
    let t = Date.now();
    const comment = `bib reuse ${t}`;
    await z(`const hl = byKey("HLNRMAAA"); hl.annotationComment = ${js(comment)}; await hl.saveTx(); return true;`);
    let r = await doneAfter(t);
    assert.equal(readJSON(ann).annotations.HLNRMAAA.comment, comment);
    assert.equal(r.report.bibReused, true, "bibliography reused");
    // an item changed (twice within a second): the translator runs, and the bib has the last edit
    t = Date.now();
    const changed = `${title} ${t}`;
    await z(`const it = byKey(${js(itemKey)}); it.setField("title", ${js(changed)} + " draft"); await it.saveTx(); await wait(600);
             it.setField("title", ${js(changed)}); await it.saveTx(); return true;`);
    // (Better BibTeX title-cases titles)
    const field = new RegExp(`title = \\{${changed}\\}`, "i");
    await waitFor(() => field.test(read(bib)), "the new title in the bib");
    r = await lastResult(root);
    assert.equal(r.report.bibReused, false, "bibliography made again");
    // an export asked for by hand always makes it afresh
    assert.equal((await exportProject(root)).bibReused, false);
  }
  finally {
    await z(`const it = byKey(${js(itemKey)}); it.setField("title", ${js(title)}); await it.saveTx(); return true;`);
    await autoOff(saved, [root]);
  }
});

test("a change made here is exported during a sync; one a sync brought down waits for it to finish", async () => {
  const root = fresh("auto-sync", { zsync: 1, collection: COLL });
  const ann = path.join(root, "refs", "annotations.json");
  const comment = () => readJSON(ann).annotations.HLNRMAAA.comment;
  const edit = (text, opts = {}) => z(`const hl = byKey("HLNRMAAA"); hl.annotationComment = ${js(text)}; await hl.saveTx(${js(opts)}); return true;`);
  // syncInProgress is a getter over the runner's private state: stand in for the runner
  const syncing = (on) => z(`
    const r = Zotero.Sync.Runner;
    if (${js(on)} && !r.zsyncReal) Zotero.Sync.Runner = Object.create(r, { syncInProgress: { get: () => true }, zsyncReal: { value: r } });
    if (!${js(on)} && r.zsyncReal) Zotero.Sync.Runner = r.zsyncReal;
    return true;`);
  const saved = await autoOn([root]);
  try {
    await waitFor(() => exists(ann), "the first export");
    await syncing(true);
    const local = `made here ${Date.now()}`;
    await edit(local);
    await waitFor(() => comment() === local, "the local edit, during a sync", 8000);
    // what a sync writes is marked skipAutoSync (see Zotero's syncLocal.js)
    const remote = `from the server ${Date.now()}`;
    await edit(remote, { skipAutoSync: true });
    await sleep(4000);
    assert.equal(comment(), local, "a change a sync brought down waits for the sync");
    await syncing(false);
    await z(`await Zotero.Notifier.trigger("finish", "sync", []); return true;`);
    await waitFor(() => comment() === remote, "the synced change, once the sync finished", 8000);
  }
  finally {
    await syncing(false);
    await autoOff(saved, [root]);
  }
});

test("auto-export follows changes Zotero announces without details: pages deleted, a file renamed", async () => {
  const root = fresh("auto-bare", { zsync: 1, collection: COLL });
  const ann = path.join(root, "refs", "annotations.json");
  const attKey = seeded.made[1].attachment.key;
  const exportedAfter = (t, what) => waitFor(async () => {
    const r = await lastResult(root);
    return r && r.auto && !r.error && Date.parse(r.at) >= t && r;
  }, what);
  const saved = await autoOn([root]);
  let name = null;
  try {
    await exportedAfter(0, "the first export");
    name = readJSON(ann).attachments[attKey].filename;
    // Zotero.PDFWorker.deletePages moves later annotations in SQL, then says only this
    let t = Date.now();
    await z(`await Zotero.Notifier.trigger("modify", "item", [byKey("HLNRMAAA").id], {}); return true;`);
    await exportedAfter(t, "an export after 'modify' without details");
    // renaming the file saves the attachment with nothing in `changed`
    const renamed = `renamed-${Date.now()}.pdf`;
    await z(`const r = await byKey(${js(attKey)}).renameAttachmentFile(${js(renamed)}); if (r !== true) throw new Error("rename: " + r); return true;`);
    await waitFor(() => readJSON(ann).attachments[attKey].filename === renamed, "the new file name");
  }
  finally {
    if (name) await z(`await byKey(${js(attKey)}).renameAttachmentFile(${js(name)}); return true;`);
    await autoOff(saved, [root]);
  }
});

const zlink = (root) =>z(`await Zotero.Zsync.link(coll, ${js(root)}); const r = await Zotero.Zsync.exportProject(${js(root)}); delete r.index; return r;`);
const zroots = () => z(`return Zotero.Zsync.roots();`);
const has = (list, p) => list.some((r) => r.toLowerCase() === p.toLowerCase());

test("unlink without deleting keeps every file and forgets the folder", async () => {
  const root = fresh("unlink-keep");
  await zlink(root);
  const before = fs.readdirSync(path.join(root, "refs"));
  const report = await z(`return await Zotero.Zsync.unlink(${js(root)});`);
  assert.deepEqual(report.deleted, []);
  assert.deepEqual(fs.readdirSync(path.join(root, "refs")), before);
  assert.ok(exists(path.join(root, "zsync.json")));
  assert.ok(!has(await zroots(), root));
});

test("unlink and delete removes only zsync's own, unchanged files", async () => {
  const root = fresh("unlink-delete");
  await zlink(root);
  // the person's own files, next to and among zsync's
  fs.writeFileSync(path.join(root, "refs", "mine.typ"), "mine");
  fs.writeFileSync(path.join(root, "refs", "zsync", "notes.txt"), "notes");
  // an output edited by hand after export
  fs.appendFileSync(path.join(root, "refs", "annotations.json"), " ");
  const report = await z(`return await Zotero.Zsync.unlink(${js(root)}, { deleteFiles: true });`);
  assert.deepEqual(report.kept, ["refs/annotations.json"]);
  assert.ok(report.deleted.includes("refs/zsync.bib"));
  assert.ok(report.deleted.includes("refs/zsync/manifest.json"));
  assert.ok(report.deleted.some((f) => f.startsWith("refs/zsync/sources/")));
  assert.ok(exists(path.join(root, "refs", "annotations.json")), "edited output kept");
  assert.equal(read(path.join(root, "refs", "mine.typ")), "mine");
  assert.equal(read(path.join(root, "refs", "zsync", "notes.txt")), "notes");
  assert.ok(!exists(path.join(root, "refs", "zsync.bib")));
  assert.ok(!exists(path.join(root, "refs", "zsync", "sources")), "emptied directory removed");
  assert.ok(!exists(path.join(root, "refs", "zsync", "images")), "emptied directory removed");
  assert.ok(exists(path.join(root, "refs", "zsync")), "directory with the person's file kept");
  assert.ok(exists(path.join(root, "zsync.json")), "zsync.json kept unless asked");
  assert.ok(!has(await zroots(), root));
});

test("unlink and delete with deleteConfig also removes zsync.json, never the folder", async () => {
  const root = fresh("unlink-all");
  await zlink(root);
  const report = await z(`return await Zotero.Zsync.unlink(${js(root)}, { deleteFiles: true, deleteConfig: true });`);
  assert.ok(report.deleted.includes("zsync.json"));
  assert.deepEqual(fs.readdirSync(root), [], "only zsync's files were there, and they are gone");
  assert.ok(exists(root), "the folder itself stays");
});

test("changing paths in zsync.json retires zsync's old files", async () => {
  const root = fresh("juggle", { zsync: 1, collection: COLL });
  await exportProject(root);
  const oldCopies = fs.readdirSync(path.join(root, "refs", "zsync", "sources"));
  assert.ok(oldCopies.length > 0);
  fs.writeFileSync(path.join(root, "zsync.json"), JSON.stringify({ zsync: 1, collection: COLL, annotations: "data/ann.json", bib: null, sources: "data/pdfs" }));
  const r = await exportProject(root);
  assert.ok(r.removed.includes("refs/annotations.json"));
  assert.ok(r.removed.includes("refs/zsync.bib"));
  assert.ok(!exists(path.join(root, "refs", "annotations.json")));
  assert.ok(!exists(path.join(root, "refs", "zsync.bib")));
  assert.ok(!exists(path.join(root, "refs", "zsync", "sources")), "old copies and their directory gone");
  assert.deepEqual(fs.readdirSync(path.join(root, "data", "pdfs")).sort(), oldCopies.sort());
  assert.ok(exists(path.join(root, "data", "ann.json")));
  // an old output edited by hand is kept, with a warning
  fs.appendFileSync(path.join(root, "data", "ann.json"), " ");
  fs.writeFileSync(path.join(root, "zsync.json"), JSON.stringify({ zsync: 1, collection: COLL, annotations: "refs/annotations.json", bib: null, sources: "data/pdfs" }));
  const r2 = await exportProject(root);
  assert.ok(exists(path.join(root, "data", "ann.json")));
  assert.ok(r2.warnings.some((w) => w.includes("kept data/ann.json")));
});

test("a renamed folder is found again and relocated", async () => {
  const a = fresh("move-a");
  await zlink(a);
  const b = path.join(PROJECTS, "move-b");
  fs.rmSync(b, { recursive: true, force: true });
  fs.renameSync(a, b);
  const state = await z(`
    const p = (await Zotero.Zsync.projects()).find((x) => x.root.toLowerCase() === ${js(a.toLowerCase())});
    const found = await Zotero.Zsync.findMoved(${js(a)});
    return { missing: p.missing, error: p.error, candidates: found.candidates };
  `);
  assert.equal(state.missing, true);
  assert.match(state.error, /not found/);
  assert.deepEqual(state.candidates.map((c) => c.toLowerCase()), [b.toLowerCase()]);
  await z(`await Zotero.Zsync.relocate(${js(a)}, ${js(b)}); return true;`);
  const roots = await zroots();
  assert.ok(has(roots, b) && !has(roots, a));
  const r = await exportProject(b);
  assert.deepEqual(r.changed, [], "same content, nothing to rewrite");
  await z(`await Zotero.Zsync.unlink(${js(b)}); return true;`);
});

test("a folder whose parent was renamed is found; copies make it ambiguous", async () => {
  const parentA = path.join(PROJECTS, "parent-a");
  const parentB = path.join(PROJECTS, "parent-b");
  fs.rmSync(parentA, { recursive: true, force: true });
  fs.rmSync(parentB, { recursive: true, force: true });
  const proj = path.join(parentA, "proj");
  fs.mkdirSync(proj, { recursive: true });
  await zlink(proj);
  fs.renameSync(parentA, parentB);
  let found = await z(`return (await Zotero.Zsync.findMoved(${js(proj)})).candidates;`);
  assert.deepEqual(found.map((c) => c.toLowerCase()), [path.join(parentB, "proj").toLowerCase()]);
  fs.cpSync(path.join(parentB, "proj"), path.join(parentB, "proj copy"), { recursive: true });
  found = await z(`return (await Zotero.Zsync.findMoved(${js(proj)})).candidates;`);
  assert.equal(found.length, 2);
  // relocating to a folder linked to another collection is refused
  const other = fresh("other-collection", { zsync: 1, collection: "ZZZZZZZZ", name: "other" });
  await assert.rejects(z(`await Zotero.Zsync.relocate(${js(proj)}, ${js(other)}); return true;`), /another collection/);
  await z(`await Zotero.Zsync.unlink(${js(proj)}); return true;`);
});

// ---- regressions from the adversarial review

const DATA = path.join(REPO, ".zt", "data");
// make an attachment's file disappear from this device while fn runs
async function withoutFile(attKey, fn) {
  const dir = path.join(DATA, "storage", attKey);
  const file = fs.readdirSync(dir).find((f) => !f.startsWith("."));
  const hidden = path.join(dir, file + ".hidden");
  fs.renameSync(path.join(dir, file), hidden);
  try { return await fn(); }
  finally { fs.renameSync(hidden, path.join(dir, file)); }
}

test("a copy is kept, not deleted, when its original is not on this device", async () => {
  const root = fresh("absent", { zsync: 1, collection: COLL });
  await exportProject(root);
  const att = seeded.made[0].attachment.key;
  const copy = path.join(root, "refs", "zsync", "sources", `${att}.pdf`);
  assert.ok(exists(copy));
  const r = await withoutFile(att, () => exportProject(root));
  assert.ok(exists(copy), "copy survives");
  assert.ok(!r.removed.some((f) => f.includes(att)));
  assert.ok(r.warnings.some((w) => w.includes(att) && /kept the copy/.test(w)));
  assert.equal(readJSON(path.join(root, "refs/annotations.json")).attachments[att].file, `refs/zsync/sources/${att}.pdf`);
});

test("a standalone document keeps its description when its file is not on this device", async () => {
  const root = fresh("absent-doc", { zsync: 1, collection: COLL });
  await exportProject(root);
  const key = standaloneKey(fixtureFile("letter"));
  const before = Object.values(readJSON(path.join(root, "refs/annotations.json")).items).find((it) => it.key === key);
  const r = await withoutFile(key, () => exportProject(root));
  const after = Object.values(readJSON(path.join(root, "refs/annotations.json")).items).find((it) => it.key === key);
  assert.deepEqual([after.citekey, after.type, after.title, after.date], [before.citekey, before.type, before.title, before.date]);
  assert.ok(r.warnings.some((w) => w.includes(key) && /kept its description/.test(w)));
});

test("a case-only change of output paths keeps the files", async () => {
  const root = fresh("case", { zsync: 1, collection: COLL });
  await exportProject(root);
  const copies = fs.readdirSync(path.join(root, "refs", "zsync", "sources")).length;
  fs.writeFileSync(path.join(root, "zsync.json"), JSON.stringify({ zsync: 1, collection: COLL, sources: "refs/Zsync/sources", bib: "refs/ZSYNC.bib" }));
  const r = await exportProject(root);
  assert.deepEqual(r.removed, []);
  assert.equal(fs.readdirSync(path.join(root, "refs", "zsync", "sources")).length, copies);
  assert.ok(exists(path.join(root, "refs", "zsync.bib")));
  const r2 = await exportProject(root);
  assert.deepEqual([r2.changed, r2.removed], [[], []]);
});

test("outputs can never be zsync.json or each other", async () => {
  for (const [cfg, re] of [
    [{ manifest: "zsync.json" }, /cannot be zsync.json/],
    [{ annotations: "ZSYNC.JSON" }, /cannot be zsync.json/],
    [{ bib: "refs/annotations.json" }, /name the same file/],
    [{ documents: { AAAAAAAA: { citekey: "x" }, BBBBBBBB: { citekey: "x" } } }, /are both "x"/],
    [{ documents: { AAAAAAAA: { date: "2026-02-30" } } }, /real date/],
  ]) {
    const root = fresh("guard", { zsync: 1, collection: COLL, ...cfg });
    await assert.rejects(exportProject(root), re, JSON.stringify(cfg));
    assert.equal(readJSON(path.join(root, "zsync.json")).zsync, 1, "zsync.json untouched");
  }
});

test("a file zsync did not write is moved aside, not overwritten", async () => {
  const root = fresh("foreign-output", { zsync: 1, collection: COLL });
  fs.mkdirSync(path.join(root, "refs"), { recursive: true });
  fs.writeFileSync(path.join(root, "refs", "annotations.json"), "{\"mine\": true}");
  fs.writeFileSync(path.join(root, "refs", "zsync.bib"), "@misc{mine, title = {Mine}}\n");
  const r = await exportProject(root);
  assert.equal(read(path.join(root, "refs", "annotations.json.zsync-backup")), "{\"mine\": true}");
  assert.equal(read(path.join(root, "refs", "zsync.bib.zsync-backup")), "@misc{mine, title = {Mine}}\n");
  assert.ok(r.warnings.some((w) => /moved your existing refs\/annotations.json/.test(w)));
  // zsync's own files are simply updated from then on
  const r2 = await exportProject(root);
  assert.ok(!r2.warnings.some((w) => /moved your existing/.test(w)));
  assert.ok(!exists(path.join(root, "refs", "annotations.json.zsync-backup-2")));
});

test("moving the manifest retires the old one and what it listed", async () => {
  const root = fresh("manifest-move", { zsync: 1, collection: COLL });
  await exportProject(root);
  fs.writeFileSync(path.join(root, "zsync.json"), JSON.stringify({ zsync: 1, collection: COLL, manifest: "state.json", copySources: "none" }));
  const r = await exportProject(root);
  assert.ok(r.removed.includes("refs/zsync/manifest.json"));
  assert.ok(r.removed.some((f) => f.startsWith("refs/zsync/sources/")));
  assert.ok(exists(path.join(root, "state.json")));
  assert.ok(!exists(path.join(root, "refs", "zsync", "sources")));
});

test("outputs at the project root have no leading slash", async () => {
  const root = fresh("rootdir", { zsync: 1, collection: COLL, sources: ".", images: "." });
  await exportProject(root);
  const d = readJSON(path.join(root, "refs/annotations.json"));
  const files = Object.values(d.attachments).map((a) => a.file).filter(Boolean);
  assert.ok(files.length && files.every((f) => !f.startsWith("/") && exists(path.join(root, f))), JSON.stringify(files));
  const imgs = Object.values(d.annotations).map((a) => a.image).filter(Boolean);
  assert.ok(imgs.every((f) => !f.startsWith("/")));
});

test("bib: null with standalone documents says they have no entries", async () => {
  const root = fresh("nobib-standalone", { zsync: 1, collection: COLL, bib: null });
  const r = await exportProject(root);
  assert.ok(r.warnings.some((w) => /"bib" is null, so the \d+ standalone documents/.test(w)));
});

test("relinking a copied folder gives it its own id; relocating to itself changes nothing", async () => {
  const a = fresh("relink-a");
  await zlink(a);
  const idA = readJSON(path.join(a, "zsync.json")).id;
  const b = fresh("relink-b");
  fs.copyFileSync(path.join(a, "zsync.json"), path.join(b, "zsync.json"));
  // link b to the sub collection instead
  const idB = await z(`const sub = Zotero.Collections.getByLibraryAndKey(lib, ${js(seeded.sub.key)}); const c = await Zotero.Zsync.link(sub, ${js(b)}); return c.id;`);
  assert.notEqual(idB, idA);
  const before = await zroots();
  await z(`await Zotero.Zsync.relocate(${js(a)}, ${js(a)}); return true;`);
  assert.deepEqual(await zroots(), before, "order unchanged");
  await z(`await Zotero.Zsync.unlink(${js(a)}); await Zotero.Zsync.unlink(${js(b)}); return true;`);
});

test("menus and settings pane render with labels", async () => {
  const out = await z(`
    const win = Zotero.getMainWindow();
    await win.ZoteroPane.collectionsView.selectByID("C" + coll.id);
    await win.ZoteroPane.buildCollectionContextMenu();
    const menu = win.document.getElementById("zotero-collectionmenu");
    menu.dispatchEvent(new win.Event("popupshowing"));
    await win.document.l10n.translateFragment(menu);
    await wait(300);
    const labels = [...menu.querySelectorAll(".zotero-custom-menu-item")].filter((e) => (e.dataset.l10nId || "").startsWith("zsync")).map((e) => [e.getAttribute("label"), e.disabled]);
    return labels;
  `);
  // the fixture collection is linked (see the "link" test), so Unlink is enabled
  assert.deepEqual(out, [["Export to zsync Project", false], ["Link zsync Project Folder…", false], ["Unlink zsync Project Folder…", false]]);
});

// ---------------------------------------------------------------- run
let failed = 0;
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  const t0 = Date.now();
  try {
    await t.fn();
    console.log(`ok    ${t.name} (${Date.now() - t0} ms)`);
  }
  catch (e) {
    failed++;
    console.log(`FAIL  ${t.name}\n      ${String(e.message).split("\n").join("\n      ")}`);
    if (e.zoteroStack) console.log(`      ${e.zoteroStack.split("\n").slice(0, 4).join("\n      ")}`);
  }
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
