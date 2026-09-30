#!/usr/bin/env node
// zt: an isolated, throwaway Zotero instance for zsync integration tests.
//
//   node test/zt.mjs start [--bbt] [--fresh] [--port 23124] [--xpi dist/zsync-x.y.z.xpi] [--data <dir>]
//   node test/zt.mjs eval <file.js>        run an async function body inside Zotero
//   node test/zt.mjs eval -e "<code>"
//   node test/zt.mjs stop
//   node test/zt.mjs log [lines]
//
// Everything lives under .zt/ in the repo (gitignored): a fresh Firefox profile,
// a fresh Zotero data directory and the debug log. The user's real profile and
// library are never touched. The dev bridge plugin (test/devbridge) and the
// zsync plugin (plugin/) are loaded from source through proxy files.
// --bbt copies the Better BibTeX .xpi from the user's real profile (read only)
// into the test profile.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RT = path.join(REPO, ".zt");
const PROFILE = path.join(RT, "profile");
let DATA = path.join(RT, "data");
const LOG = path.join(RT, "zotero.log");
const STATE = path.join(RT, "state.json");
const ZOTERO_EXE = process.env.ZOTERO_EXE || "C:/Program Files/Zotero/zotero.exe";
const REAL_PROFILES = path.join(process.env.APPDATA || "", "Zotero", "Zotero", "Profiles");
const BBT_ID = "better-bibtex@iris-advies.com";

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); }
  catch { return null; }
}

function pluginId(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  return m.applications.zotero.id;
}

function findRealBBT() {
  if (!fs.existsSync(REAL_PROFILES)) return null;
  for (const p of fs.readdirSync(REAL_PROFILES)) {
    const f = path.join(REAL_PROFILES, p, "extensions", `${BBT_ID}.xpi`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/connector/ping`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? r.headers.get("x-zotero-version") : null;
  }
  catch { return null; }
}

export async function zeval(code, { state = readState(), timeoutMs = 300000 } = {}) {
  if (!state) throw new Error("no running test instance (node test/zt.mjs start)");
  const r = await fetch(`http://127.0.0.1:${state.port}/zsync-dev/eval`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zsync-dev-token": state.token },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`bridge returned ${r.status}: ${text.slice(0, 500)}`); }
  if (!body.ok) {
    const e = new Error(body.error);
    e.zoteroStack = body.stack;
    throw e;
  }
  return body.result;
}

async function start() {
  const port = Number(opt("--port", 23124));
  if (await ping(port)) {
    console.log(`already running on ${port}`);
    return;
  }
  if (flag("--fresh")) fs.rmSync(RT, { recursive: true, force: true });
  // --data <dir>: open another data directory (for example a copy of a real
  // library) instead of the fixture one
  if (opt("--data", null)) DATA = path.resolve(opt("--data"));
  fs.mkdirSync(path.join(PROFILE, "extensions"), { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  const token = randomBytes(24).toString("hex");
  const prefs = {
    "extensions.zotero.httpServer.port": port,
    "extensions.zotero.httpServer.enabled": true,
    "extensions.zotero.httpServer.localAPI.enabled": true,
    "extensions.zotero.firstRun2": false,
    "extensions.zotero.firstRunGuidance": false,
    "extensions.zotero.sync.autoSync": false,
    "extensions.zotero.automaticScraperUpdates": false,
    "extensions.zotero.autoRecognizeFiles": false,
    "extensions.zotero.autoRenameFiles": false,
    "extensions.zotero.reportTranslationFailure": false,
    "extensions.zotero.debug.log": true,
    "extensions.autoDisableScopes": 0,
    "extensions.update.enabled": false,
    "app.update.auto": false,
    "app.update.enabled": false,
    "browser.shell.checkDefaultBrowser": false,
    "extensions.zsyncdev.enabled": true,
    "extensions.zsyncdev.token": token,
    // on by default for people; the tests that need it switch it on
    "extensions.zsync.autoExport": false,
  };
  const userJs = Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n";
  fs.writeFileSync(path.join(PROFILE, "user.js"), userJs);

  // Force an extension rescan on every start so source edits and new proxy
  // files are picked up (same trick as the Zotero plugin docs).
  const prefsJs = path.join(PROFILE, "prefs.js");
  if (fs.existsSync(prefsJs)) {
    const kept = fs.readFileSync(prefsJs, "utf8").split(/\r?\n/)
      .filter((l) => !/extensions\.lastAppBuildId|extensions\.lastAppVersion/.test(l));
    fs.writeFileSync(prefsJs, kept.join("\n"));
  }

  // zsync itself: from source (a proxy file), or the packed .xpi with --xpi
  const zsyncId = pluginId(path.join(REPO, "plugin"));
  const xpi = opt("--xpi", null);
  fs.rmSync(path.join(PROFILE, "extensions", zsyncId), { force: true });
  fs.rmSync(path.join(PROFILE, "extensions", `${zsyncId}.xpi`), { force: true });
  const proxies = [path.join(REPO, "test", "devbridge")];
  if (xpi) fs.copyFileSync(path.resolve(xpi), path.join(PROFILE, "extensions", `${zsyncId}.xpi`));
  else proxies.push(path.join(REPO, "plugin"));
  for (const dir of proxies) {
    fs.writeFileSync(path.join(PROFILE, "extensions", pluginId(dir)), dir.replaceAll("/", "\\") + "\\");
  }
  if (flag("--bbt")) {
    const src = findRealBBT();
    if (!src) throw new Error("Better BibTeX .xpi not found in the real Zotero profile");
    fs.copyFileSync(src, path.join(PROFILE, "extensions", `${BBT_ID}.xpi`));
  }

  const out = fs.openSync(LOG, "a");
  const child = spawn(ZOTERO_EXE, ["-profile", PROFILE, "-no-remote", "-datadir", DATA, "-ZoteroDebugText"], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: false,
  });
  child.unref();
  fs.writeFileSync(STATE, JSON.stringify({ port, token, pid: child.pid, started: new Date().toISOString() }, null, 1));

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const v = await ping(port);
    if (v) {
      // The bridge registers after Zotero.initializationPromise, and plugins
      // start one after another: Better BibTeX alone can take a few minutes.
      for (let j = 0; j < 300; j++) {
        try {
          const info = await zeval("return { version: Zotero.version, dataDir: Zotero.DataDirectory.dir, profile: Zotero.Profile.dir };");
          console.log(JSON.stringify({ port, ...info }));
          return;
        }
        catch (e) {
          if (!/404|No endpoint|fetch failed|bridge returned 404/.test(String(e.message))) throw e;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(`Zotero ${v} answered on ${port} but the dev bridge never registered; see ${LOG}`);
    }
  }
  throw new Error(`Zotero did not start on ${port}; see ${LOG}`);
}

async function stop() {
  const state = readState();
  if (!state || !(await ping(state.port))) {
    console.log("not running");
    return;
  }
  try {
    await zeval("setTimeout(() => Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit), 200); return true;", { state, timeoutMs: 10000 });
  }
  catch {
    // setTimeout may not exist in the sandbox; fall back to Zotero's helper.
    await zeval("Zotero.Utilities.Internal.quit(); return true;", { state, timeoutMs: 10000 }).catch(() => {});
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!(await ping(state.port))) {
      console.log("stopped");
      return;
    }
  }
  console.log("still running; kill pid", state.pid);
}

async function main() {
  if (cmd === "start") return start();
  if (cmd === "stop") return stop();
  if (cmd === "log") {
    const n = Number(args[0] || 80);
    const lines = fs.readFileSync(LOG, "utf8").split(/\r?\n/);
    console.log(lines.slice(-n).join("\n"));
    return;
  }
  if (cmd === "eval") {
    const code = args[0] === "-e" ? args[1] : fs.readFileSync(args[0], "utf8");
    const result = await zeval(code);
    console.log(JSON.stringify(result, null, 1));
    return;
  }
  console.log("usage: node test/zt.mjs start [--bbt] [--fresh] | eval <file>|-e <code> | stop | log [n]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    if (e.zoteroStack) console.error(e.zoteroStack);
    process.exit(1);
  });
}
