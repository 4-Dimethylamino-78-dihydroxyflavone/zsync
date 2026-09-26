#!/usr/bin/env node
// Packs plugin/ into dist/zsync-<version>.xpi and rewrites updates.json so
// every Zotero that has zsync installed can find the new version.
//
//   node scripts/build.mjs            build + update updates.json
//   node scripts/build.mjs --no-update
//
// No dependencies: the zip is written by hand (deflate via node:zlib) with
// forward-slash paths and manifest.json at the root, which is all Zotero needs.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO, "plugin");
const DIST = path.join(REPO, "dist");
const RELEASE = JSON.parse(fs.readFileSync(path.join(REPO, "scripts", "release.json"), "utf8"));

function walk(dir, rel = "") {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, r));
    else out.push({ abs, rel: r });
  }
  return out;
}

// DOS date/time for a fixed timestamp, so identical sources give identical xpis
function dosDateTime(d) {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

function zip(files) {
  const { time, date } = dosDateTime(new Date(Date.UTC(2026, 0, 1)));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { rel, data } of files) {
    const name = Buffer.from(rel, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
const { version } = manifest;
const { id, strict_min_version, strict_max_version } = manifest.applications.zotero;
const files = walk(SRC).map((f) => ({ rel: f.rel, data: fs.readFileSync(f.abs) }));
if (!files.some((f) => f.rel === "manifest.json")) throw new Error("plugin/manifest.json missing");

fs.mkdirSync(DIST, { recursive: true });
const xpiName = `zsync-${version}.xpi`;
const xpi = zip(files);
fs.writeFileSync(path.join(DIST, xpiName), xpi);
const sha256 = crypto.createHash("sha256").update(xpi).digest("hex");
console.log(`${xpiName}  ${files.length} files  ${xpi.length} bytes  sha256:${sha256}`);

if (!process.argv.includes("--no-update")) {
  const link = RELEASE.downloadURL.replaceAll("{version}", version).replaceAll("{file}", xpiName);
  const updates = {
    addons: {
      [id]: {
        updates: [{
          version,
          update_link: link,
          update_hash: `sha256:${sha256}`,
          applications: { zotero: { strict_min_version, strict_max_version } },
        }],
      },
    },
  };
  fs.writeFileSync(path.join(REPO, "updates.json"), JSON.stringify(updates, null, 2) + "\n");
  console.log(`updates.json -> ${link}`);
}
