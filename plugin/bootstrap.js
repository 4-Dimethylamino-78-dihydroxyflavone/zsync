/* global Zotero, Services, APP_SHUTDOWN */
// zsync: export a Zotero collection to a Typst project folder.
// The modules in content/ each add one part to the Zsync namespace.
// Top-level names are `var`: Zotero keeps this sandbox across disable and
// enable, and runs startup() again in it.
var Zsync;

var ZSYNC_MODULES = ["util", "snapshot", "standalone", "config", "collect", "bib", "exporter", "auto", "ui", "api"];

function install() {}

async function startup({ id, version, rootURI }) {
  for (const name of ZSYNC_MODULES) {
    Services.scriptloader.loadSubScriptWithOptions(`${rootURI}content/${name}.js`, { ignoreCache: true });
  }
  Zsync = globalThis.Zsync;
  Zsync.id = id;
  Zsync.version = version;
  Zsync.rootURI = rootURI;
  await Zsync.ui.startup({ id, rootURI });
  Zsync.auto.startup();
  Zotero.Zsync = Zsync.api;
  // learn what each registered folder is linked to (for Unlink and Find),
  // in the background once the window is up
  Promise.resolve(Zotero.uiReadyPromise).then(() => Zsync.config.projects()).catch((e) => Zotero.logError(e));
  Zsync.util.log(`${version} started`);
}

function onMainWindowLoad({ window }) {
  if (Zsync && Zsync.ui) Zsync.ui.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  if (Zsync && Zsync.ui) Zsync.ui.removeFromWindow(window);
}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  if (!Zsync) return;
  Zsync.auto.shutdown();
  Zsync.ui.shutdown();
  if (Zotero.Zsync === Zsync.api) delete Zotero.Zsync;
}

function uninstall() {}
