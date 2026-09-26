#!/usr/bin/env node
// Writes the fixture PDFs and the email-thread snapshot used by the
// integration tests, plus fixtures.json describing where every line of text
// sits in PDF user space (so tests can build highlight rects that cover real
// text). Courier is used because every glyph is exactly 0.6 em wide.
//
//   node test/fixtures/make-fixtures.mjs   -> test/fixtures/out/*
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const FONT_SIZE = 12;
const CHAR_W = 0.6 * FONT_SIZE;
const ASCENT = 0.629 * FONT_SIZE;   // Courier cap height, close enough for rects
const DESCENT = 0.157 * FONT_SIZE;

function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// pages: [{ mediaBox, cropBox?, rotate?, lines: [{ x, y, text }] }]
// info: optional Info dictionary, e.g. { Title, Author, CreationDate }
function writePdf(file, pages, info = null) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const kids = [];
  for (const p of pages) {
    const ops = p.lines.map((l) => `BT /F1 ${FONT_SIZE} Tf ${l.x} ${l.y} Td (${esc(l.text)}) Tj ET`).join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(ops, "latin1")} >>\nstream\n${ops}\nendstream`);
    let dict = `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [${p.mediaBox.join(" ")}]`;
    if (p.cropBox) dict += ` /CropBox [${p.cropBox.join(" ")}]`;
    if (p.rotate) dict += ` /Rotate ${p.rotate}`;
    dict += ` /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`;
    kids.push(add(dict));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  const infoObj = info
    ? add(`<< ${Object.entries(info).map(([k, v]) => `/${k} (${esc(v)})`).join(" ")} >>`)
    : null;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  const infoRef = infoObj ? ` /Info ${infoObj} 0 R` : "";
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${infoRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, Buffer.from(out, "latin1"));
}

// [x1, y1, x2, y2] covering chars [from, to) of a line, PDF user space
function rectFor(line, from = 0, to = line.text.length) {
  return [
    +(line.x + from * CHAR_W).toFixed(3), +(line.y - DESCENT).toFixed(3),
    +(line.x + to * CHAR_W).toFixed(3), +(line.y + ASCENT).toFixed(3),
  ];
}

function linesFrom(texts, { x = 72, top = 720, lead = 18 } = {}) {
  return texts.map((text, i) => ({ x, y: top - i * lead, text }));
}

const PARA = [
  "The quick brown fox jumps over the lazy dog.",
  "Residents must not store bicycles in corridors.",
  "A leaking tap was reported in room 12.",
  "Management agreed to inspect within five days.",
  "This line continues onto the next page and the",
];
const PARA2 = [
  "highlight that spans both pages ends right here.",
  "A second paragraph for underline tests.",
  "Figure 1: a box drawn for the image annotation.",
];

const fixtures = {
  normal: {
    file: "normal.pdf",
    pages: [
      { mediaBox: [0, 0, 612, 792], lines: linesFrom(PARA) },
      { mediaBox: [0, 0, 612, 792], lines: linesFrom(PARA2) },
    ],
  },
  rotated: {
    file: "rotated.pdf",
    pages: [{ mediaBox: [0, 0, 612, 792], rotate: 90, lines: linesFrom(PARA.slice(0, 3)) }],
  },
  cropbox: {
    file: "cropbox.pdf",
    pages: [{ mediaBox: [0, 0, 612, 792], cropBox: [50, 100, 562, 742], lines: linesFrom(PARA.slice(0, 3)) }],
  },
  mediaOffset: {
    file: "media-offset.pdf",
    pages: [{ mediaBox: [100, 200, 712, 992], lines: linesFrom(PARA.slice(0, 3), { x: 172, top: 920 }) }],
  },
  // standalone files (no parent item), named the way people name them
  notice: {
    file: "2026-09-04_HOUSING_Inspection Notice for Room 12_OPTIMISED-ii.pdf",
    pages: [{ mediaBox: [0, 0, 612, 792], lines: linesFrom(PARA.slice(1, 4)) }],
  },
  handbook: {
    file: "UNI_Riverside Village 2026_[Resident Handbook 2026]_(document).pdf",
    pages: [{ mediaBox: [0, 0, 612, 792], lines: linesFrom(PARA.slice(0, 2)) }],
  },
  // letters and a printed email, to be recognised from their text
  letter: {
    file: "Letter_101.pdf",
    pages: [{ mediaBox: [0, 0, 612, 792], lines: linesFrom(["2026-09-24", "Letter 101", "From: Sam Resident", "To: Village Office",
      "Good afternoon,", "This is a request to release my stored items.", "Thank you,", "-Sam"]) }],
  },
  formalLetter: {
    file: "scan0002.pdf",
    pages: [{ mediaBox: [0, 0, 612, 792], lines: linesFrom(["Housing Office", "1 Example Street", "21 September 2026", "Dear Ms Resident,",
      "Re: Inspection of room 12", "We will inspect the room on Friday.", "Yours sincerely,", "Alex Manager", "Property Manager"]) }],
  },
  printedEmail: {
    file: "email-printout.pdf",
    pages: [{ mediaBox: [0, 0, 612, 792], lines: linesFrom(["From: Robin Oldham <robin@example.org>", "Sent: Thursday, 17 September 2026 19:52",
      "To: Sam Resident <sam@example.org>", "Subject: Bicycle storage", "Hi Sam,", "Please remove the item.", "Regards,", "Robin Oldham"]) }],
  },
  scan: {
    file: "scan0001.pdf",
    info: { Title: "Tenancy Rules Summary", Author: "Housing Office", CreationDate: "D:20250102030405+10'00'" },
    pages: [{ mediaBox: [0, 0, 612, 792], lines: linesFrom(PARA.slice(2, 4)) }],
  },
};

// Outlook-style reply thread saved as a snapshot: the newest message on top,
// the highlighted sentence in the older, quoted one.
const THREAD = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>RE: [EXTERNAL] Meeting - Room inspection</title></head>
<body>
<div id="m1">
<p><b>From:</b> Alex Newman &lt;alex.newman@example.org&gt;<br>
<b>Sent:</b> Monday, 21 September 2026 16:33<br>
<b>To:</b> Sam Resident &lt;sam@example.org&gt;<br>
<b>Subject:</b> RE: [EXTERNAL] Meeting - Room inspection</p>
<p>Thanks Sam, we can meet on Wednesday at 11am.</p>
<p>Kind regards,</p>
<p>Alex Newman<br>Housing Coordinator</p>
</div>
<hr>
<div id="m2">
<p><b>From:</b> Robin Oldham &lt;robin.oldham@example.org&gt;<br>
<b>Sent:</b> Thursday, 17 September 2026 19:52<br>
<b>To:</b> Sam Resident &lt;sam@example.org&gt;<br>
<b>Subject:</b> [EXTERNAL] Meeting - Room inspection</p>
<p>Hi Sam,</p>
<p id="quote">As bicycles are a fire hazard they may not be stored in the corridors, including outside your room.</p>
<p>Regards,</p>
<p>Robin Oldham<br>Facilities Officer</p>
</div>
</body></html>
`;

fs.mkdirSync(OUT, { recursive: true });
const described = {};
for (const [name, fx] of Object.entries(fixtures)) {
  writePdf(path.join(OUT, fx.file), fx.pages, fx.info);
  described[name] = {
    file: fx.file,
    pages: fx.pages.map((p) => ({
      ...p,
      lines: p.lines.map((l) => ({ ...l, rect: rectFor(l) })),
    })),
  };
}
fs.writeFileSync(path.join(OUT, "thread.html"), THREAD);
described.thread = { file: "thread.html", quoteId: "quote" };
described.metrics = { fontSize: FONT_SIZE, charWidth: CHAR_W, ascent: ASCENT, descent: DESCENT };
fs.writeFileSync(path.join(OUT, "fixtures.json"), JSON.stringify(described, null, 1));
console.log(`wrote ${Object.keys(fixtures).length} PDFs + thread.html to ${OUT}`);

export { rectFor };
