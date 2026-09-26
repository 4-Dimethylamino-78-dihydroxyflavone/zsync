#!/usr/bin/env node
// Seeds the isolated test library (see test/zt.mjs) with the fixture
// collection zsync's integration tests export. Idempotent: it deletes and
// recreates the "zsync fixture" collection and its items each run.
//
//   node test/fixtures/make-fixtures.mjs && node test/seed.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zeval } from "./zt.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "test", "fixtures", "out");
const fx = JSON.parse(fs.readFileSync(path.join(OUT, "fixtures.json"), "utf8"));
const html = fs.readFileSync(path.join(OUT, "thread.html"), "utf8");

// Offset of the quoted sentence inside #quote's text, and inside the whole
// document text (for the snapshot sortIndex, which is a document offset).
const quoteText = html.match(/<p id="quote">([^<]*)<\/p>/)[1];
const hlText = "bicycles are a fire hazard they may not be stored in the corridors";
const hlStart = quoteText.indexOf(hlText);

const L = (name, page, line) => fx[name].pages[page].lines[line];
const R = (name, page, line) => L(name, page, line).rect;
const sort = (page, offset, top) =>
  `${String(page).padStart(5, "0")}|${String(offset).padStart(6, "0")}|${String(Math.round(top)).padStart(5, "0")}`;
const top = (rect) => 792 - rect[3];

const spec = {
  dir: OUT,
  standalone: [
    [fx.notice.file, "HLNTCAAA"],
    [fx.handbook.file, "HLHBKAAA"],
    [fx.scan.file, "HLSCNAAA"],
    [fx.letter.file, "HLLTRAAA"],
    [fx.formalLetter.file, "HLFRMAAA"],
    [fx.printedEmail.file, "HLEMLAAA"],
  ],
  items: [
    {
      type: "document", title: "Normal fixture document", citationKey: "doe2026normal", date: "2026-09-17",
      creators: [{ firstName: "Jane", lastName: "Doe", creatorType: "author" }],
      extra: "Email-Sent-ISO: 2026-09-17T19:52:00\nOriginal-Date: 2026",
      tags: ["fixture"],
      file: "normal.pdf",
      annotations: [
        { key: "HLNRMAAA", type: "highlight", text: L("normal", 0, 1).text, comment: "my comment", color: "#ffd400", pageLabel: "1",
          sortIndex: sort(0, 45, top(R("normal", 0, 1))), position: { pageIndex: 0, rects: [R("normal", 0, 1)] }, tags: [{ name: "evidence" }] },
        { key: "ULNRMAAA", type: "underline", text: L("normal", 0, 2).text, comment: "", color: "#2ea8e5", pageLabel: "1",
          sortIndex: sort(0, 90, top(R("normal", 0, 2))), position: { pageIndex: 0, rects: [R("normal", 0, 2)] } },
        { key: "NTNRMAAA", type: "note", comment: "a sticky note", color: "#5fb236", pageLabel: "1",
          sortIndex: sort(0, 0, 60), position: { pageIndex: 0, rects: [[500, 700, 522, 722]] } },
        { key: "TXNRMAAA", type: "text", comment: "free text on the page", color: "#000000", pageLabel: "1",
          sortIndex: sort(0, 200, 400), position: { pageIndex: 0, fontSize: 14, rotation: 0, rects: [[72, 360, 272, 392]] } },
        { key: "INNRMAAA", type: "ink", color: "#ff6666", pageLabel: "1",
          sortIndex: sort(0, 300, 500), position: { pageIndex: 0, width: 2, paths: [[80, 300, 120, 260, 160, 300, 200, 260]] } },
        { key: "IMNRMAAA", type: "image", comment: "the figure", color: "#a28ae5", pageLabel: "2",
          sortIndex: sort(1, 0, top(R("normal", 1, 2))), position: { pageIndex: 1, rects: [[60, R("normal", 1, 2)[1] - 10, 420, R("normal", 1, 2)[3] + 10]] } },
        { key: "HLSPANAA", type: "highlight", text: `${L("normal", 0, 4).text} ${L("normal", 1, 0).text}`, comment: "crosses pages", color: "#ff6666", pageLabel: "1",
          sortIndex: sort(0, 180, top(R("normal", 0, 4))), position: { pageIndex: 0, rects: [R("normal", 0, 4)], nextPageRects: [R("normal", 1, 0)] } },
      ],
    },
    {
      type: "journalArticle", title: "Rotated page fixture", citationKey: "roe2025rotated", date: "2025",
      creators: [{ firstName: "Richard", lastName: "Roe", creatorType: "author" }],
      file: "rotated.pdf",
      annotations: [
        { key: "HLRTAAAA", type: "highlight", text: L("rotated", 0, 1).text, color: "#ffd400", pageLabel: "1",
          sortIndex: sort(0, 45, 0), position: { pageIndex: 0, rects: [R("rotated", 0, 1)] } },
      ],
    },
    {
      type: "document", title: "CropBox fixture", citationKey: "crop2024box", date: "2024-01-02",
      creators: [{ name: "Standards Body", creatorType: "author" }],
      file: "cropbox.pdf",
      annotations: [
        { key: "HLCRPAAA", type: "highlight", text: L("cropbox", 0, 2).text, color: "#ffd400", pageLabel: "1",
          sortIndex: sort(0, 90, 0), position: { pageIndex: 0, rects: [R("cropbox", 0, 2)] } },
      ],
    },
    {
      type: "document", title: "MediaBox offset fixture", citationKey: "media2024offset", date: "2024",
      file: "media-offset.pdf",
      annotations: [
        { key: "HLMEDIAA", type: "highlight", text: L("mediaOffset", 0, 0).text, color: "#ffd400", pageLabel: "1",
          sortIndex: sort(0, 0, 0), position: { pageIndex: 0, rects: [R("mediaOffset", 0, 0)] } },
      ],
    },
    {
      type: "email", subject: "RE: [EXTERNAL] Meeting - Room inspection", citationKey: "newman2026meeting", date: "2026-09-21",
      creators: [{ firstName: "Alex", lastName: "Newman", creatorType: "author" }, { firstName: "Sam", lastName: "Resident", creatorType: "recipient" }],
      extra: "Email-Sent-ISO: 2026-09-21T16:33:00",
      file: "thread.html",
      annotations: [
        { key: "HLMAILAA", type: "highlight", text: hlText, comment: "the rule they cite", color: "#ffd400",
          sortIndex: String(html.indexOf(hlText)).padStart(8, "0"),
          position: { type: "CssSelector", value: "#quote", refinedBy: { type: "TextPositionSelector", start: hlStart, end: hlStart + hlText.length } } },
      ],
    },
    { type: "webpage", title: "Item without a citation key or files", date: "2026", url: "https://example.org/", subcollection: false },
    {
      type: "document", title: "Only in the subcollection", citationKey: "sub2026only", subcollection: true,
      file: "normal.pdf",
      annotations: [
        { key: "HLSUBAAA", type: "highlight", text: L("normal", 0, 0).text, color: "#ffd400", pageLabel: "1",
          sortIndex: sort(0, 0, 0), position: { pageIndex: 0, rects: [R("normal", 0, 0)] } },
      ],
    },
    { type: "document", title: "Linked file that is missing", citationKey: "gone2026missing", missingFile: true },
  ],
};

const code = `
const spec = ${JSON.stringify(spec)};
const lib = Zotero.Libraries.userLibraryID;
// wipe earlier runs
for (const c of Zotero.Collections.getByLibrary(lib)) {
  if (c.name === "zsync fixture") {
    const ids = [];
    for (const cc of [c, ...Zotero.Collections.getByParent(c.id, true)]) ids.push(...cc.getChildItems(true));
    if (ids.length) await Zotero.Items.erase(ids);
    await c.eraseTx({ deleteItems: true });
  }
}
const root = new Zotero.Collection({ name: "zsync fixture", libraryID: lib });
await root.saveTx();
const sub = new Zotero.Collection({ name: "sub", libraryID: lib, parentID: root.id });
await sub.saveTx();

const made = [];
for (const s of spec.items) {
  const item = new Zotero.Item(s.type);
  item.libraryID = lib;
  if (s.title) item.setField("title", s.title);
  if (s.subject) item.setField("subject", s.subject);
  if (s.date) item.setField("date", s.date);
  if (s.url) item.setField("url", s.url);
  if (s.extra) item.setField("extra", s.extra);
  if (s.citationKey) item.setField("citationKey", s.citationKey);
  if (s.creators) item.setCreators(s.creators);
  for (const t of s.tags || []) item.addTag(t);
  item.addToCollection(s.subcollection ? sub.id : root.id);
  await item.saveTx();
  const rec = { title: s.title || s.subject, id: item.id, key: item.key, annotations: [] };
  if (s.file) {
    const att = await Zotero.Attachments.importFromFile({ file: PathUtils.join(spec.dir, s.file), parentItemID: item.id });
    rec.attachment = { id: att.id, key: att.key, contentType: att.attachmentContentType, reader: att.attachmentReaderType };
    for (const a of s.annotations || []) {
      const ann = await Zotero.Annotations.saveFromJSON(att, a);
      rec.annotations.push(ann.key);
    }
  }
  if (s.missingFile) {
    const att = await Zotero.Attachments.linkFromFile({ file: PathUtils.join(spec.dir, "normal.pdf"), parentItemID: item.id });
    // point the link somewhere that does not exist
    att.attachmentPath = PathUtils.join(spec.dir, "does-not-exist.pdf");
    await att.saveTx();
    rec.attachment = { id: att.id, key: att.key, missing: true };
  }
  made.push(rec);
}
// a standalone PDF directly in the collection, with one highlight
const lone = await Zotero.Attachments.importFromFile({ file: PathUtils.join(spec.dir, "cropbox.pdf"), collections: [root.id] });
const loneAnn = await Zotero.Annotations.saveFromJSON(lone, { key: "HLLNEAAA", type: "highlight", text: "standalone", color: "#ffd400", pageLabel: "1",
  sortIndex: "00000|000000|00000", position: { pageIndex: 0, rects: [[72, 700, 200, 712]] } });
made.push({ title: "standalone attachment", id: lone.id, key: lone.key, annotations: [loneAnn.key] });
// standalone files named the way people name them, one highlight each
for (const [file, key] of spec.standalone) {
  const att = await Zotero.Attachments.importFromFile({ file: PathUtils.join(spec.dir, file), collections: [root.id] });
  const ann = await Zotero.Annotations.saveFromJSON(att, { key, type: "highlight", text: "standalone " + key, color: "#ffd400", pageLabel: "1",
    sortIndex: "00000|000000|00000", position: { pageIndex: 0, rects: [[72, 700, 200, 712]] } });
  made.push({ title: att.getField("title"), id: att.id, key: att.key, file, annotations: [ann.key] });
}
return { collection: { id: root.id, key: root.key }, sub: { id: sub.id, key: sub.key }, made };
`;

const result = await zeval(code);
fs.writeFileSync(path.join(OUT, "seeded.json"), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
