/* global Zsync, Zotero, setTimeout, clearTimeout */
// Auto-export: watch Zotero for changes to anything a project exported, and
// re-export that project a few seconds after the last change. Off unless the
// extensions.zsync.autoExport preference is on (per device).
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.auto = (() => {
  const PREF_ON = "extensions.zsync.autoExport";
  const PREF_DELAY = "extensions.zsync.debounceMs";
  const TYPES = ["item", "collection-item", "item-tag", "collection", "sync"];
  // Item events that can change an export. 'refresh' and 'index' come from
  // full-text indexing; an erased annotation is caught by its 'delete'.
  const ITEM_EVENTS = new Set(["add", "modify", "delete", "trash"]);
  // While Zotero syncs, changes arrive in many small batches; wait for the
  // sync to finish, but never longer than this.
  const MAX_SYNC_WAIT = 120000;

  let observerID = null;
  let prefObserver = null;
  let running = false;
  const timers = new Map();   // root -> timeout
  const since = new Map();    // root -> when its first pending change arrived
  const watched = new Map();  // root -> { libraryID, collectionIDs:Set, ids:Set, keys:Set }
  const last = new Map();     // root -> { at, report | error }

  function enabled() {
    return !!Zotero.Prefs.get(PREF_ON, true);
  }

  function delay() {
    const ms = Number(Zotero.Prefs.get(PREF_DELAY, true));
    return Number.isFinite(ms) && ms >= 500 ? ms : 5000;
  }

  // Called after every export (manual or automatic) with its report. Only
  // folders in this device's project list are watched.
  function remember(root, report) {
    const registered = Zsync.config.roots().some((r) => Zsync.config.sameFolder(r, root));
    if (report && report.index && registered) {
      const i = report.index;
      watched.set(root, {
        libraryID: i.libraryID,
        collectionIDs: new Set(i.collectionIDs),
        ids: new Set(i.ids),
        keys: new Set(i.keys),
      });
    }
    last.set(root, { at: new Date().toISOString(), report, error: null });
  }

  function failed(root, error) {
    last.set(root, { at: new Date().toISOString(), report: null, error: String((error && error.message) || error) });
  }

  // Does this notifier event touch what the project exported?
  function touches(w, event, type, ids, extraData) {
    if (type === "collection-item") {
      return ids.some((id) => w.collectionIDs.has(Number(String(id).split("-")[0])));
    }
    if (type === "item-tag") {
      return ids.some((id) => w.ids.has(Number(String(id).split("-")[0])));
    }
    if (type === "collection") {
      return ids.some((id) => {
        if (w.collectionIDs.has(Number(id))) return true;
        const c = Zotero.Collections.get(Number(id));
        return !!(c && c.parentID && w.collectionIDs.has(c.parentID));
      });
    }
    if (type !== "item" || !ITEM_EVENTS.has(event)) return false;
    for (const id of ids) {
      const x = extraData && extraData[id];
      if (event === "modify") {
        // opening or closing a PDF saves its last-read time: nothing changed
        if (x && x.changed && typeof x.changed === "object" && !Object.keys(x.changed).length) continue;
        // Zotero announcing a PNG that zsync itself just rendered
        if (Zsync.exporter.wasRendered(Number(id))) continue;
      }
      if (w.ids.has(Number(id))) return true;
      if (event === "delete") {
        if (x && x.libraryID === w.libraryID && w.keys.has(x.key)) return true;
        continue;
      }
      // something new: an annotation on a watched attachment, an attachment
      // on a watched item, or an item placed in a watched collection
      const item = Zotero.Items.get(Number(id));
      if (!item || item.libraryID !== w.libraryID) continue;
      if (item.parentID && w.ids.has(item.parentID)) return true;
      if (!item.parentID && item.getCollections().some((c) => w.collectionIDs.has(c))) return true;
    }
    return false;
  }

  function syncing() {
    try { return !!(Zotero.Sync && Zotero.Sync.Runner && Zotero.Sync.Runner.syncInProgress); }
    catch (e) { return false; }
  }

  function schedule(root, ms = delay()) {
    clearTimeout(timers.get(root));
    if (!since.has(root)) since.set(root, Date.now());
    timers.set(root, setTimeout(() => {
      timers.delete(root);
      if (!running) return;
      if (syncing() && Date.now() - since.get(root) < MAX_SYNC_WAIT) {
        schedule(root);
        return;
      }
      since.delete(root);
      exportNow(root);
    }, ms));
  }

  function exportNow(root) {
    return Zsync.exporter.run(root, { priority: false }).then(
      (report) => { remember(root, report); return report; },
      (e) => { failed(root, e); Zsync.util.log(`auto-export of ${root} failed: ${e.message || e}`); },
    );
  }

  const observer = {
    notify(event, type, ids, extraData) {
      if (!running) return;
      try {
        if (type === "sync") {
          // a sync just ended: export what it changed without further delay
          if (event === "finish") for (const root of timers.keys()) schedule(root, 1000);
          return;
        }
        for (const [root, w] of watched) {
          if (touches(w, event, type, ids, extraData)) schedule(root);
        }
      }
      catch (e) {
        Zotero.logError(e);
      }
    },
  };

  // Export every project once, which also records what each one watches.
  async function primeAll() {
    for (const p of await Zsync.config.projects()) {
      if (!running) return;
      if (!p.cfg) {
        failed(p.root, p.error);
        continue;
      }
      // unlinked while this was running
      if (!Zsync.config.roots().some((r) => Zsync.config.sameFolder(r, p.root))) continue;
      await exportNow(p.root);
    }
  }

  function start() {
    if (running) return;
    running = true;
    observerID = Zotero.Notifier.registerObserver(observer, TYPES, "zsync");
    // Catch up with changes made while Zotero was closed (or synced from
    // another device) once the UI is up, without holding up startup.
    Promise.resolve(Zotero.uiReadyPromise).then(primeAll).catch((e) => Zotero.logError(e));
    Zsync.util.log("auto-export on");
  }

  function stop() {
    running = false;
    if (observerID) Zotero.Notifier.unregisterObserver(observerID);
    observerID = null;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    since.clear();
    Zsync.util.log("auto-export off");
  }

  function startup() {
    prefObserver = Zotero.Prefs.registerObserver(PREF_ON, (value) => (value ? start() : stop()), true);
    if (enabled()) start();
  }

  function shutdown() {
    stop();
    if (prefObserver) Zotero.Prefs.unregisterObserver(prefObserver);
    prefObserver = null;
    watched.clear();
  }

  // A project folder was removed from the list
  function forget(root) {
    clearTimeout(timers.get(root));
    timers.delete(root);
    since.delete(root);
    for (const k of [...watched.keys()]) if (Zsync.config.sameFolder(k, root)) watched.delete(k);
  }

  // Drop the remembered result of the last export (for the Settings pane).
  function forgetResult(root) {
    for (const k of [...last.keys()]) if (Zsync.config.sameFolder(k, root)) last.delete(k);
  }

  return { startup, shutdown, remember, failed, forget, forgetResult, touches, last, watched, enabled, isRunning: () => running };
})();
