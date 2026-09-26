/* global Zsync, Zotero, IOUtils, PathUtils, Components */
// Small helpers shared by every module. Nothing here touches the Zotero
// database; file helpers only ever write inside a project folder.
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.util = (() => {
  const KEY_RE = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

  function log(msg) {
    if (typeof Zotero !== "undefined") Zotero.debug(`zsync: ${msg}`);
  }

  function isKey(value) {
    return typeof value === "string" && KEY_RE.test(value);
  }

  // JSON with object keys in a fixed order (insertion order for the objects we
  // build, sorted for maps), two-space indent and a trailing newline, so
  // unchanged data always serialises to identical bytes.
  function stableStringify(value) {
    return JSON.stringify(value, null, 2) + "\n";
  }

  function sortedObject(map) {
    const out = {};
    for (const k of Object.keys(map).sort()) out[k] = map[k];
    return out;
  }

  // "Email-Sent-ISO: 2026-09-21T16:33:12" lines, the same rule as the
  // transcript template's parse-extra: a key without spaces or colons.
  function parseExtra(extra) {
    const out = {};
    for (const line of String(extra || "").split(/\r?\n/)) {
      const m = line.match(/^([^\s:]+):\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  }

  // Zotero's multipart SQL date ("2026-09-17 2026-09-17", "2025-00-00 2025")
  // to the parsed part only: "2026-09-17", "2025", or null.
  function isoFromMultipart(sqlDate) {
    const m = String(sqlDate || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m || m[1] === "0000") return null;
    if (m[2] === "00") return m[1];
    if (m[3] === "00") return `${m[1]}-${m[2]}`;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  // "2026-09-25 22:58:02" (UTC, Zotero's storage format) -> "2026-09-25T22:58:02Z"
  function isoFromSQL(sql) {
    const m = String(sql || "").match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
    return m ? `${m[1]}T${m[2]}Z` : null;
  }

  // Remove whole top-level fields from BibTeX/BibLaTeX text. Both Better
  // BibTeX and Zotero's own translators put each field on its own line
  // ("  file = {...},"), and a field value may continue over several lines,
  // so a field ends where its braces balance.
  function stripBibFields(text, fields) {
    if (!fields || !fields.length) return text;
    const names = new Set(fields.map((f) => f.toLowerCase()));
    const delta = (line) => {
      let d = 0;
      for (const ch of line.replace(/\\[{}]/g, "")) {
        if (ch === "{") d++;
        else if (ch === "}") d--;
      }
      return d;
    };
    const lines = text.split("\n");
    const out = [];
    let depth = 0;  // 1 = directly inside an entry, where fields start
    for (let i = 0; i < lines.length; i++) {
      const m = depth === 1 && lines[i].match(/^\s+([A-Za-z][\w-]*)\s*=\s*/);
      if (!m || !names.has(m[1].toLowerCase())) {
        out.push(lines[i]);
        depth += delta(lines[i]);
        continue;
      }
      let d = delta(lines[i]);
      let j = i;
      while (d > 0 && j < lines.length - 1) d += delta(lines[++j]);
      // a closing brace of the entry itself on the field's last line
      if (d < 0) {
        out.push("}".repeat(-d));
        depth += d;
      }
      i = j;
    }
    return out.join("\n");
  }

  // ---- paths: project-relative paths are always forward-slashed and may not
  // climb out of the project folder.
  function projectPath(root, rel) {
    if (typeof rel !== "string" || !rel.trim()) throw new Error("empty path in zsync.json");
    const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = clean.split("/").filter((p) => p && p !== ".");
    if (parts.some((p) => p === "..") || /^[a-zA-Z]:/.test(clean)) {
      throw new Error(`zsync.json paths must stay inside the project folder: ${rel}`);
    }
    return PathUtils.join(root, ...parts);
  }

  function relPath(rel) {
    return rel.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((p) => p && p !== ".").join("/");
  }

  // ---- files
  async function readTextIfExists(path) {
    try {
      return await IOUtils.readUTF8(path);
    }
    catch (e) {
      if (e.name === "NotFoundError") return null;
      throw e;
    }
  }

  // Write only when the content differs; write to a temporary file first and
  // move it into place so a reader never sees half a file. Returns true when
  // the file changed.
  async function writeTextIfChanged(path, text) {
    const current = await readTextIfExists(path);
    if (current === text) return false;
    await IOUtils.makeDirectory(PathUtils.parent(path), { createAncestors: true, ignoreExisting: true });
    await IOUtils.writeUTF8(path, text, { tmpPath: path + ".zsync-tmp" });
    return true;
  }

  async function copyFileAtomic(src, dst) {
    await IOUtils.makeDirectory(PathUtils.parent(dst), { createAncestors: true, ignoreExisting: true });
    const tmp = dst + ".zsync-tmp";
    try {
      await IOUtils.copy(src, tmp);
      await IOUtils.move(tmp, dst);
    }
    finally {
      await IOUtils.remove(tmp, { ignoreAbsent: true });
    }
  }

  async function statOrNull(path) {
    try {
      return await IOUtils.stat(path);
    }
    catch (e) {
      if (e.name === "NotFoundError") return null;
      throw e;
    }
  }

  // SHA-256 of a file, read in 1 MiB chunks so a 100 MB PDF is never in memory
  // at once.
  async function sha256File(path) {
    const hasher = Components.classes["@mozilla.org/security/hash;1"]
      .createInstance(Components.interfaces.nsICryptoHash);
    hasher.init(hasher.SHA256);
    const chunk = 1024 * 1024;
    let offset = 0;
    for (;;) {
      const bytes = await IOUtils.read(path, { offset, maxBytes: chunk });
      if (bytes.length) hasher.update(bytes, bytes.length);
      offset += bytes.length;
      if (bytes.length < chunk) break;
    }
    const bin = hasher.finish(false);
    let hex = "";
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    return hex;
  }

  function sha256Text(text) {
    const hasher = Components.classes["@mozilla.org/security/hash;1"]
      .createInstance(Components.interfaces.nsICryptoHash);
    hasher.init(hasher.SHA256);
    const bytes = new TextEncoder().encode(text);
    hasher.update(bytes, bytes.length);
    const bin = hasher.finish(false);
    let hex = "";
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    return hex;
  }

  // Remove directories that are now empty, walking up from each of `dirs`
  // but never removing `root` itself or anything outside it.
  async function pruneEmptyDirs(root, dirs) {
    const norm = (p) => PathUtils.normalize(p).replace(/[\\/]+$/, "");
    const top = norm(root);
    const inside = (p) => {
      const a = Zotero.isWin ? norm(p).toLowerCase() : norm(p);
      const b = Zotero.isWin ? top.toLowerCase() : top;
      return a !== b && (a.startsWith(b + "\\") || a.startsWith(b + "/"));
    };
    // deepest first, so a parent is only looked at after its children
    const ordered = [...new Set(dirs)].sort((a, b) => b.length - a.length);
    for (let dir of ordered) {
      while (dir && inside(dir)) {
        let children;
        try { children = await IOUtils.getChildren(dir); }
        catch (e) { break; }  // already gone
        if (children.length) break;
        try { await IOUtils.remove(dir); }
        catch (e) { break; }
        dir = PathUtils.parent(dir);
      }
    }
  }

  function extname(filename) {
    const m = String(filename || "").match(/\.([A-Za-z0-9]{1,8})$/);
    return m ? m[1].toLowerCase() : "";
  }

  return {
    log, isKey, stableStringify, sortedObject, parseExtra, isoFromMultipart, isoFromSQL,
    stripBibFields, projectPath, relPath, readTextIfExists, writeTextIfChanged, copyFileAtomic,
    statOrNull, sha256File, sha256Text, extname, pruneEmptyDirs,
  };
})();
