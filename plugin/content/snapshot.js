/* global Zsync */
// For a highlight in a saved email thread (an HTML snapshot), find the
// message that holds it: sender, sent time, recipients, subject and signoff.
// A thread is filed under its newest message, but the sentence you highlighted
// is often in an older one, written by someone else, days earlier.
//
// Everything here works on a DOM Document and plain strings, so it can be
// tested outside Zotero.
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.snapshot = (() => {
  const BLOCK = new Set(["address", "article", "blockquote", "br", "div", "dl", "dt", "dd", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "ol", "p", "pre", "section", "table",
    "tbody", "td", "th", "thead", "tr", "ul"]);
  const SKIP = new Set(["script", "style", "head", "title", "noscript", "template"]);
  const SIGNOFFS = new Set(["kind regards", "regards", "best regards", "warm regards", "many thanks",
    "thanks", "thank you", "cheers", "sincerely", "yours sincerely", "yours faithfully", "best",
    "best wishes", "all the best"]);
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december"];

  // The document's text with a line break around every block element. Each
  // text node's start offset in the result is recorded in `starts`.
  function flatten(doc) {
    const parts = [];
    const starts = new Map();
    let n = 0;
    const visit = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          starts.set(c, n);
          parts.push(c.data);
          n += c.data.length;
        }
        else if (c.nodeType === 1) {
          const tag = c.localName.toLowerCase();
          if (SKIP.has(tag)) continue;
          const block = BLOCK.has(tag);
          if (block) { parts.push("\n"); n++; }
          visit(c);
          if (block) { parts.push("\n"); n++; }
        }
      }
    };
    visit(doc.body || doc.documentElement);
    return { text: parts.join(""), starts };
  }

  // Every text node under el in document order: Zotero's reader counts a
  // TextPositionSelector's offsets over all of them, raw (untrimmed).
  function textNodesUnder(el) {
    const out = [];
    const visit = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out.push(c);
        else if (c.nodeType === 1) visit(c);
      }
    };
    visit(el);
    return out;
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Where the highlight starts in the flattened text: through its CSS
  // selector and text offset when they resolve, else by searching for its
  // first words (whitespace-insensitive).
  function locate(doc, flat, position, text) {
    if (position && position.type === "CssSelector" && position.value) {
      // the reader resolves selectors with document.body.querySelector
      let el = null;
      try { el = (doc.body || doc).querySelector(position.value); }
      catch (e) { el = null; }
      if (el) {
        const start = (position.refinedBy && Number.isInteger(position.refinedBy.start)) ? position.refinedBy.start : 0;
        let seen = 0;
        for (const t of textNodesUnder(el)) {
          if (seen + t.data.length > start && flat.starts.has(t)) return flat.starts.get(t) + (start - seen);
          seen += t.data.length;
        }
      }
    }
    const words = String(text || "").split(/\s+/).filter(Boolean).slice(0, 12).map(escapeRe);
    if (words.length) {
      const m = new RegExp(words.join("\\s+")).exec(flat.text);
      if (m) return m.index;
    }
    return null;
  }

  function oneLine(s) {
    return String(s).replace(/ /g, " ").replace(/\s+/g, " ").trim();
  }

  // Outlook and friends: "Monday, 21 September 2026 16:33",
  // "Thursday, 17 September 2026 7:52 PM", "Monday, September 21, 2026 4:33 PM",
  // "21 September 2026 16:33", "21/09/2026 4:33 PM". Returns local ISO time
  // without an offset ("2026-09-21T16:33:00"), or null.
  function parseSent(s) {
    let v = oneLine(s).replace(/^[A-Za-z]+,\s*/, "").replace(/\s+at\s+/i, " ");
    let day, month, year, rest;
    let m;
    if ((m = v.match(/^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4}),?\s*(.*)$/))) {
      [, day, month, year, rest] = m;
    }
    else if ((m = v.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4}),?\s*(.*)$/))) {
      [, month, day, year, rest] = m;
    }
    else if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(.*)$/))) {
      [, day, month, year, rest] = m;
    }
    else {
      return null;
    }
    let mon;
    if (/^\d+$/.test(month)) mon = Number(month);
    else {
      const i = MONTHS.findIndex((name) => name.startsWith(month.toLowerCase()) && month.length >= 3);
      if (i < 0) return null;
      mon = i + 1;
    }
    const d = Number(day);
    if (mon < 1 || mon > 12 || d < 1 || d > 31) return null;
    let hh = 0, mm = 0, ss = 0;
    if (rest) {
      const t = rest.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?/);
      if (!t) return null;
      hh = Number(t[1]);
      mm = Number(t[2]);
      ss = t[3] ? Number(t[3]) : 0;
      if (t[4]) {
        const pm = /^p/i.test(t[4]);
        if (hh === 12) hh = pm ? 12 : 0;
        else if (pm) hh += 12;
      }
      if (hh > 23 || mm > 59 || ss > 59) return null;
    }
    const p2 = (x) => String(x).padStart(2, "0");
    return `${year}-${p2(mon)}-${p2(d)}T${p2(hh)}:${p2(mm)}:${p2(ss)}`;
  }

  // Every From:/Sent:/To:/Subject: block in a thread, top (newest) first.
  // "Date:" is accepted in place of "Sent:" (Apple Mail, Thunderbird).
  function headers(flat) {
    const out = [];
    const re = /From:/g;
    let m;
    while ((m = re.exec(flat))) {
      const chunk = flat.slice(m.index, m.index + 900);
      const sent = /(?:Sent|Date):[ \t ]*([^\n]+)/.exec(chunk);
      if (!sent || sent.index > 450) continue;
      const get = (k) => {
        const r = new RegExp(k + ":[ \\t\\u00a0]*([^\\n]*)").exec(chunk);
        return r ? oneLine(r[1]) || null : null;
      };
      const subj = /Subject:[ \t ]*[^\n]*/.exec(chunk);
      out.push({
        pos: m.index,
        end: m.index + (subj ? subj.index + subj[0].length : sent.index + sent[0].length),
        from: get("From"),
        sent: oneLine(sent[1]),
        to: get("To"),
        subject: get("Subject"),
      });
    }
    return out;
  }

  function signoff(body) {
    const lines = body.split("\n").map(oneLine);
    for (let i = 0; i < lines.length; i++) {
      if (SIGNOFFS.has(lines[i].toLowerCase().replace(/[,.!]+$/, ""))) {
        for (const next of lines.slice(i + 1)) {
          if (next) return next;
        }
      }
    }
    return null;
  }

  function messageAt(flatText, pos) {
    const hs = headers(flatText);
    let i = -1;
    for (let k = 0; k < hs.length; k++) {
      if (hs[k].pos <= pos) i = k;
    }
    if (i < 0) return null;
    const h = hs[i];
    const end = i + 1 < hs.length ? hs[i + 1].pos : flatText.length;
    return {
      "from": h.from,
      "sent": h.sent,
      "sent-iso": parseSent(h.sent),
      "to": h.to,
      "subject": h.subject,
      "signoff": signoff(flatText.slice(h.end, end)),
      // 1 is the message at the top of the thread (the newest)
      "index": i + 1,
      "count": hs.length,
    };
  }

  // One parsed snapshot, reusable for all of its annotations.
  function prepare(doc) {
    const flat = flatten(doc);
    return {
      message(position, text) {
        const pos = locate(doc, flat, position, text);
        return pos === null ? null : messageAt(flat.text, pos);
      },
    };
  }

  return { flatten, locate, parseSent, headers, signoff, messageAt, prepare };
})();
