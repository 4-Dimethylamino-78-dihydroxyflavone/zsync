/* global Zotero, Services */
// Dev-only bridge for the isolated test instance started by test/zt.mjs.
// POST /zsync-dev/eval  {"code": "<async function body>"}  with header
// X-Zsync-Dev-Token matching the extensions.zsyncdev.token pref.
// Refuses to run unless the pref extensions.zsyncdev.enabled is true, which
// only test/zt.mjs writes (into a throwaway profile).

const PATH = "/zsync-dev/eval";
let registered = null;

function install() {}
function uninstall() {}

async function startup() {
  await Zotero.initializationPromise;
  if (!Services.prefs.getBoolPref("extensions.zsyncdev.enabled", false)) {
    Zotero.debug("zsync devbridge: not enabled in this profile; staying inert");
    return;
  }
  const token = Services.prefs.getStringPref("extensions.zsyncdev.token", "");
  if (token.length < 16) {
    Zotero.debug("zsync devbridge: token missing; staying inert");
    return;
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const scope = this;
  registered = class {
    supportedMethods = ["POST"];
    supportedDataTypes = ["application/json"];
    async init({ headers, data }) {
      if (headers["x-zsync-dev-token"] !== token) {
        return [403, "application/json", JSON.stringify({ ok: false, error: "bad token" })];
      }
      try {
        const fn = new AsyncFunction("Zotero", "Services", "IOUtils", "PathUtils", "ChromeUtils", "Components", "scope", String(data.code || ""));
        const result = await fn(Zotero, Services, IOUtils, PathUtils, ChromeUtils, Components, scope);
        return [200, "application/json", JSON.stringify({ ok: true, result: result === undefined ? null : result })];
      }
      catch (e) {
        return [200, "application/json", JSON.stringify({ ok: false, error: String(e && e.message || e), stack: String(e && e.stack || "") })];
      }
    }
  };
  Zotero.Server.Endpoints[PATH] = registered;
  Zotero.debug("zsync devbridge: listening on " + PATH);
}

function shutdown() {
  if (registered && Zotero.Server.Endpoints[PATH] === registered) {
    delete Zotero.Server.Endpoints[PATH];
  }
  registered = null;
}
