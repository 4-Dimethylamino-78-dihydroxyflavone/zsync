/* global Zsync, Zotero, IOUtils, PathUtils, setTimeout, clearTimeout */
// Auto-export: watch Zotero for changes to anything a project exported, and
// each project's zsync.json for edits, and re-export that project shortly
// after the last change. On unless the extensions.zsync.autoExport
// preference is off (per device).
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.auto = (() => {
  const PREF_ON = "extensions.zsync.autoExport";
  const PREF_DELAY = "extensions.zsync.debounceMs";
  const TYPES = ["item", "collection-item", "item-tag", "collection", "sync"];
  // Item events that can change an export. 'refresh' and 'index' come from
  // full-text indexing; an erased annotation is caught by its 'delete'.
  const ITEM_EVENTS = new Set(["add", "modify", "delete", "trash"]);
  // Changes a sync brings down arrive in many small batches; wait for the
  // sync to finish (looking again every SYNC_RECHECK), but never longer than
  // MAX_SYNC_WAIT. Changes made here do not wait: they are complete when
  // Zotero announces them, and Zotero starts a sync to upload them 3 s
  // later, which would otherwise hold up their export.
  const MAX_SYNC_WAIT = 120000;
  const SYNC_RECHECK = 2000;
  // Every POLL_MS, one stat of each project's zsync.json, off the main
  // thread: an edit re-exports the project, and a folder that comes back (a
  // drive plugged in again) is exported and watched again.
  const POLL_MS = 2000;
  // An automatic export that failed is tried again after RETRY_FIRST, then
  // twice as long each time, up to RETRY_MAX.
  const RETRY_FIRST = 30000;
  const RETRY_MAX = 30 * 60000;
  // How long an erased object is looked for in later exports' output
  const ERASED_KEEP = 60000;
  // The longest an export waits for changes to stop (see exportDelay)
  const MAX_WAIT = 20000;

  let observerID = null;
  let prefObserver = null;
  let running = false;
  let pollTimer = null;
  let polls = 0;              // which run of the poller is the current one
  const timers = new Map();   // root -> timeout
  const since = new Map();    // root -> when its first pending change arrived
  const remote = new Set();   // roots with a pending change that a sync brought down
  const watched = new Map();  // root -> { libraryID, recursive, collectionIDs:Set, ids:Set, keys:Set }
  const last = new Map();     // root -> { at, report | error, auto }
  const took = new Map();     // root -> how long its last export took (ms)
  const stamps = new Map();   // root -> "<size>:<mtime>" of its zsync.json, "" while it is missing
  const retries = new Map();  // root -> { at, wait } after a failed automatic export
  const notified = new Map(); // root -> true once its failure was shown, until it exports again
  const erased = new Map();   // "<libraryID>/<key>" -> when it was erased (lately)

  function enabled() {
    return !!Zotero.Prefs.get(PREF_ON, true);
  }

  function baseDelay() {
    const ms = Number(Zotero.Prefs.get(PREF_DELAY, true));
    return Number.isFinite(ms) && ms >= 250 ? ms : 1500;
  }

  // How long to wait, after the latest change to a project, before exporting
  // it. Every newer change starts the wait again, so the export runs once
  // things have been quiet for this long.
  //   base      the extensions.zsync.debounceMs preference (1500 unless changed)
  //   lastMs    how long this project's previous export took, or null before its first
  //   waitedMs  how long ago the first change that is not exported yet arrived
  // All in milliseconds. Return the delay: 0 exports right away.
  //
  // Quiet for `base`, as long as that does not put the export more than
  // MAX_WAIT after the first change it has to catch up with: a long burst
  // (highlighting one passage after another, or a comment typed on and on,
  // which Zotero saves at least every 10 s) still reaches Typst every
  // 20 seconds. Like ZotLit's freshness notifier, with more breathing room
  // than its 10 s. lastMs is not used.
  function exportDelay({ base, waitedMs }) {
    return Math.max(0, Math.min(base, MAX_WAIT - waitedMs));
  }

  function delayFor(root) {
    const now = Date.now();
    let ms = NaN;
    try {
      const lastMs = lookup(took, root);
      ms = Number(exportDelay({ base: baseDelay(), lastMs: lastMs === undefined ? null : lastMs, waitedMs: now - (since.get(root) || now) }));
    }
    catch (e) {
      Zotero.logError(e);
    }
    // whatever the policy says, exports keep happening
    return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 60000) : baseDelay();
  }

  // ---- per-folder bookkeeping, under whichever spelling of the path
  function lookup(map, root) {
    if (map.has(root)) return map.get(root);
    for (const [k, v] of map) if (Zsync.config.sameFolder(k, root)) return v;
    return undefined;
  }

  function setIn(map, root, value) {
    for (const k of [...map.keys()]) if (k !== root && Zsync.config.sameFolder(k, root)) map.delete(k);
    map.set(root, value);
  }

  function dropIn(map, root) {
    for (const k of [...map.keys()]) if (Zsync.config.sameFolder(k, root)) map.delete(k);
  }

  function registered(root) {
    return Zsync.config.roots().some((r) => Zsync.config.sameFolder(r, root));
  }

  // Called after every export (manual or automatic) with its report. Only
  // folders in this device's project list are watched.
  function remember(root, report, { auto = false } = {}) {
    if (report && report.index && registered(root)) {
      const i = report.index;
      setIn(watched, root, {
        libraryID: i.libraryID,
        recursive: !!i.recursive,
        collectionIDs: new Set(i.collectionIDs),
        ids: new Set(i.ids),
        keys: new Set(i.keys),
        paths: new Map(i.paths || []),
      });
      dropIn(retries, root);
      // it read something that has been erased since: export once more
      if (running && readErased(i)) schedule(root);
    }
    if (report && Number.isFinite(report.ms)) setIn(took, root, report.ms);
    setIn(last, root, { at: new Date().toISOString(), report, error: null, auto });
    dropIn(notified, root);
  }

  // auto: the export was automatic, so nobody saw it fail: say so once,
  // until the project exports again (not on every retry, nor on every
  // autosave of a zsync.json being edited). quiet: record it, say nothing.
  function failed(root, error, { auto = false, quiet = false } = {}) {
    const message = String((error && error.message) || error);
    setIn(last, root, { at: new Date().toISOString(), report: null, error: message, auto });
    if (auto && !quiet && running && !lookup(notified, root)) {
      let shown = false;
      try { shown = !!Zsync.ui.notifyAutoFailure(root, message); }
      catch (e) { Zotero.logError(e); }
      // with no Zotero window open, it is said when a later attempt fails
      if (shown) setIn(notified, root, true);
    }
  }

  // An object erased while an export that had already read it was running
  // stays in that export's output, and the watch set it replaces did not
  // know the object yet. Remember erasures for a minute, and look for them
  // in each new watch set.
  function noteErased(ids, extraData) {
    const now = Date.now();
    for (const id of ids) {
      const x = extraData[id];
      if (x && x.key) erased.set(`${x.libraryID}/${x.key}`, now);
    }
  }

  function readErased(index) {
    if (!erased.size) return false;
    const now = Date.now();
    const keys = new Set(index.keys);
    let hit = false;
    for (const [k, at] of erased) {
      if (now - at > ERASED_KEEP) {
        erased.delete(k);
        continue;
      }
      const slash = k.indexOf("/");
      if (Number(k.slice(0, slash)) === index.libraryID && keys.has(k.slice(slash + 1))) {
        // once: the next export cannot read it again
        erased.delete(k);
        hit = true;
      }
    }
    return hit;
  }

  function retryLater(root) {
    const r = lookup(retries, root);
    const wait = r ? Math.min(r.wait * 2, RETRY_MAX) : RETRY_FIRST;
    setIn(retries, root, { at: Date.now() + wait, wait });
  }

  // Is this collection one the project exports, or (recursive) inside one?
  function covers(w, collectionID) {
    if (w.collectionIDs.has(collectionID)) return true;
    if (!w.recursive) return false;
    // a subcollection made or moved in since the last export
    let c = Zotero.Collections.get(collectionID);
    for (let n = 0; c && c.parentID && n < 64; n++) {
      if (w.collectionIDs.has(c.parentID)) return true;
      c = Zotero.Collections.get(c.parentID);
    }
    return false;
  }

  // Is the file of an exported attachment not the one exported any more
  // (renamed, or relinked with Locate…)?
  function fileMoved(w, id) {
    if (!w.paths || !w.paths.has(id)) return false;
    const att = Zotero.Items.get(id);
    return !!att && (att.attachmentPath || null) !== w.paths.get(id);
  }

  // Notes (and images inside notes) are not exported, and a note being
  // written saves every few seconds: none of that is a change to a project.
  function inNote(item) {
    for (let it = item, n = 0; it && n < 4; it = it.parentID ? Zotero.Items.get(it.parentID) : null, n++) {
      if (it.isNote()) return true;
    }
    return false;
  }

  // Does this notifier event touch what the project exported?
  function touches(w, event, type, ids, extraData) {
    if (type === "collection-item") {
      return ids.some((id) => covers(w, Number(String(id).split("-")[0])));
    }
    if (type === "item-tag") {
      return ids.some((id) => w.ids.has(Number(String(id).split("-")[0])));
    }
    if (type === "collection") {
      return ids.some((id) => {
        if (w.collectionIDs.has(Number(id))) return true;
        const c = Zotero.Collections.get(Number(id));
        return !!(c && c.parentID && w.recursive && covers(w, c.parentID));
      });
    }
    if (type !== "item" || !ITEM_EVENTS.has(event)) return false;
    for (const id of ids) {
      const x = extraData && extraData[id];
      if (event === "modify") {
        // An empty `changed`: opening or closing a PDF saved its last-read
        // time. A file renamed or relinked is saved the same way, so look
        // at the attachment's path. Anything else counts, also without
        // `changed`: pages deleted in the reader move later annotations and
        // say only 'modify', and a parent told that a child was added may
        // carry its own edit, merged into the same notification.
        if (x && x.changed && typeof x.changed === "object" && !Object.keys(x.changed).length && !fileMoved(w, Number(id))) continue;
        // Zotero announcing a PNG that zsync itself just rendered
        if (Zsync.exporter.wasRendered(Number(id))) continue;
      }
      if (w.ids.has(Number(id))) return true;
      if (event === "delete") {
        if (x && x.libraryID === w.libraryID && w.keys.has(x.key)) return true;
        continue;
      }
      // Something new under something the project exported, or placed in a
      // collection it covers. Walk up, so that an annotation on an attachment
      // added since the last export counts too.
      let item = Zotero.Items.get(Number(id));
      if (!item || item.libraryID !== w.libraryID || inNote(item)) continue;
      for (let n = 0; item.parentID && n < 4; n++) {
        if (w.ids.has(item.parentID)) return true;
        item = Zotero.Items.get(item.parentID);
        if (!item) break;
      }
      if (item && !item.parentID && item.getCollections().some((c) => covers(w, c))) return true;
    }
    return false;
  }

  function syncing() {
    try { return !!(Zotero.Sync && Zotero.Sync.Runner && Zotero.Sync.Runner.syncInProgress); }
    catch (e) { return false; }
  }

  // ---- scheduling
  // fromSync: the change was written by a sync (Zotero marks those events
  // skipAutoSync), so more of the same sync may still be on its way.
  function schedule(root, { fromSync = false } = {}) {
    if (!since.has(root)) since.set(root, Date.now());
    if (fromSync) remote.add(root);
    fireIn(root, delayFor(root));
  }

  function fireIn(root, ms) {
    clearTimeout(timers.get(root));
    timers.set(root, setTimeout(() => fire(root), ms));
  }

  function fire(root) {
    timers.delete(root);
    if (!running) return;
    if (remote.has(root) && syncing() && Date.now() - (since.get(root) || 0) < MAX_SYNC_WAIT) {
      fireIn(root, SYNC_RECHECK);
      return;
    }
    since.delete(root);
    remote.delete(root);
    // unlinked meanwhile
    if (!registered(root)) return;
    exportNow(root);
  }

  function exportNow(root) {
    return Zsync.exporter.run(root, { priority: false }).then(
      (report) => { remember(root, report, { auto: true }); return report; },
      async (e) => {
        let error = e;
        const missing = !(await IOUtils.exists(root).catch(() => false));
        if (missing) error = new Error(`the project folder ${root} is missing (renamed, moved, or on a drive that is not connected?); Settings → zsync can find it`);
        failed(root, error, { auto: true });
        retryLater(root);
        Zsync.util.log(`auto-export of ${root} failed: ${(e && e.message) || e}`);
      },
    );
  }

  // A sync just ended: export what it changed without further delay, and
  // try again the projects that are not watched (it may have brought their
  // collection or group library).
  function syncFinished() {
    for (const root of [...timers.keys()]) fireIn(root, 1000);
    for (const root of Zsync.config.roots()) {
      if (lookup(watched, root) === undefined && lookup(stamps, root)) schedule(root);
    }
  }

  const observer = {
    notify(event, type, ids, extraData) {
      if (!running) return;
      try {
        if (type === "sync") {
          if (event === "finish") syncFinished();
          return;
        }
        const fromSync = !!(extraData && extraData.skipAutoSync);
        for (const [root, w] of watched) {
          if (touches(w, event, type, ids, extraData)) schedule(root, { fromSync });
        }
        if (type === "item" && event === "delete" && extraData) noteErased(ids, extraData);
      }
      catch (e) {
        Zotero.logError(e);
      }
    },
  };

  // ---- zsync.json of every project, and retries
  async function pollOnce() {
    const roots = Zsync.config.roots();
    const seen = await Promise.all(roots.map((root) => IOUtils.stat(PathUtils.join(root, Zsync.config.FILE))
      .then((st) => `${st.size}:${st.lastModified}`, () => "")));
    if (!running) return;
    const now = Date.now();
    roots.forEach((root, i) => {
      const stamp = seen[i];
      const before = stamps.get(root);
      stamps.set(root, stamp);
      // the first look only takes note: startup exports every project anyway
      if (before === undefined || !stamp) return;
      if (stamp !== before) {
        // edited, or back after being away
        dropIn(retries, root);
        schedule(root);
        return;
      }
      const r = lookup(retries, root);
      if (r && now >= r.at && !timers.has(root)) {
        r.at = Infinity;  // until this attempt's result sets the next one
        schedule(root);
      }
    });
    for (const k of [...stamps.keys()]) if (!roots.includes(k)) stamps.delete(k);
  }

  function startPolling() {
    const run = ++polls;
    const tick = async () => {
      if (run !== polls || !running) return;
      try { await pollOnce(); }
      catch (e) { Zotero.logError(e); }
      if (run === polls && running) pollTimer = setTimeout(tick, POLL_MS);
    };
    tick();
  }

  function stopPolling() {
    polls++;
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  // Export every project once, which also records what each one watches.
  async function primeAll() {
    for (const p of await Zsync.config.projects()) {
      if (!running) return;
      if (!p.cfg) {
        // a folder on a drive that is not connected is not news at startup;
        // the poller exports it when it comes back
        failed(p.root, p.error, { auto: true, quiet: p.missing });
        continue;
      }
      // unlinked while this was running
      if (!registered(p.root)) continue;
      await exportNow(p.root);
    }
  }

  function start() {
    if (running) return;
    running = true;
    observerID = Zotero.Notifier.registerObserver(observer, TYPES, "zsync");
    startPolling();
    // Catch up with changes made while Zotero was closed (or synced from
    // another device) once the UI is up, without holding up startup.
    Promise.resolve(Zotero.uiReadyPromise).then(primeAll).catch((e) => Zotero.logError(e));
    Zsync.util.log("auto-export on");
  }

  function stop() {
    running = false;
    if (observerID) Zotero.Notifier.unregisterObserver(observerID);
    observerID = null;
    stopPolling();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    since.clear();
    remote.clear();
    stamps.clear();
    retries.clear();
    notified.clear();
    erased.clear();
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
    for (const k of [...timers.keys()]) {
      if (Zsync.config.sameFolder(k, root)) {
        clearTimeout(timers.get(k));
        timers.delete(k);
        since.delete(k);
        remote.delete(k);
      }
    }
    for (const map of [watched, stamps, retries, took, notified]) dropIn(map, root);
  }

  // Drop the remembered result of the last export (for the Settings pane).
  function forgetResult(root) {
    dropIn(last, root);
  }

  return {
    startup, shutdown, remember, failed, forget, forgetResult, touches, exportDelay, last, watched, enabled,
    isRunning: () => running,
  };
})();
