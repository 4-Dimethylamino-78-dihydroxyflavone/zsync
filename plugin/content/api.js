/* global Zsync, Zotero, IOUtils, PathUtils */
// Zotero.Zsync: the few calls the Settings pane, tests and Run JavaScript use.
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.api = {
  get version() {
    return Zsync.version;
  },

  // Export one project folder (queued behind any export already running).
  async exportProject(root) {
    const report = await Zsync.exporter.run(root);
    Zsync.auto.remember(root, report);
    return report;
  },

  // Export every registered project; failures are reported, not thrown.
  async exportAll() {
    const out = [];
    for (const p of await Zsync.config.projects()) {
      if (!p.cfg) {
        out.push({ root: p.root, error: p.error });
        continue;
      }
      // unlinked while this batch was running
      if (!Zsync.config.roots().some((r) => Zsync.config.sameFolder(r, p.root))) continue;
      try {
        out.push(await this.exportProject(p.root));
      }
      catch (e) {
        Zsync.auto.failed(p.root, e);
        out.push({ root: p.root, error: e.message });
      }
    }
    return out;
  },

  // Link a collection to a folder without asking (creates or re-points its
  // zsync.json) and remember the folder on this device.
  async link(collection, root) {
    const existing = await Zsync.config.read(root);
    if (!existing) await Zsync.config.create(root, collection);
    else if (existing.collection !== collection.key) await Zsync.config.relink(root, collection);
    const cfg = await Zsync.config.read(root);
    Zsync.config.addProject(root, cfg);
    return cfg;
  },

  // Stop exporting to a folder on this device. deleteFiles: also delete the
  // files zsync wrote there (only those still exactly as zsync wrote them);
  // deleteConfig: also delete its zsync.json. Returns what was deleted/kept.
  async unlink(root, { deleteFiles = false, deleteConfig = false } = {}) {
    Zsync.auto.forget(root);
    Zsync.config.removeRoot(root);
    let report = { root, deleted: [], kept: [], noManifest: false };
    if (await IOUtils.exists(root)) {
      if (deleteFiles) {
        report = await Zsync.exporter.queue(() => Zsync.exporter.removeOutputs(root, { config: deleteConfig }));
      }
      else if (deleteConfig) {
        const file = PathUtils.join(root, Zsync.config.FILE);
        await Zsync.exporter.queue(async () => {
          if (!(await IOUtils.exists(file))) return;
          try {
            await IOUtils.remove(file, { retryReadonly: true });
            report.deleted.push(Zsync.config.FILE);
          }
          catch (e) {
            report.failed = [Zsync.config.FILE];
          }
        });
      }
    }
    Zsync.auto.forgetResult(root);
    return report;
  },

  // A registered folder that has gone missing: where might it be now?
  findMoved(root, options) {
    return Zsync.config.findMoved(root, options);
  },

  // Point a registered folder at its new location. This does not export:
  // the caller exports newRoot so that auto-export watches it again.
  async relocate(oldRoot, newRoot) {
    const cfg = await Zsync.config.relocate(oldRoot, newRoot);
    if (!Zsync.config.sameFolder(oldRoot, newRoot)) {
      Zsync.auto.forget(oldRoot);
      Zsync.auto.forgetResult(oldRoot);
    }
    return cfg;
  },

  // zsync.json of a folder: null if there is none, throws if it is invalid
  readConfig(root) {
    return Zsync.config.read(root);
  },

  addProject(root, cfg) {
    return Zsync.config.addProject(root, cfg);
  },

  projects() {
    return Zsync.config.projects();
  },

  roots() {
    return Zsync.config.roots();
  },

  addRoot(root) {
    return Zsync.config.addRoot(root);
  },

  removeRoot(root) {
    Zsync.auto.forget(root);
    return Zsync.config.removeRoot(root);
  },

  // Last result per folder: { at, report, error }
  lastResult(root) {
    for (const [k, v] of Zsync.auto.last) if (Zsync.config.sameFolder(k, root)) return v;
    return null;
  },

  pickFolder(win, title) {
    return Zsync.ui.pickFolder(win, title);
  },

  exportRoots(roots, win) {
    return Zsync.ui.exportRoots(roots, win);
  },

  // The dialogs behind Settings' Unlink… and Find… buttons
  unlinkInteractive(win, root) {
    return Zsync.ui.unlinkInteractive(win, root);
  },

  async findInteractive(win, root) {
    const found = await Zsync.ui.findInteractive(win, root);
    if (found) await Zsync.ui.exportRoots([found], win);
    return found;
  },

  t(id, args) {
    return Zsync.ui.t(id, args);
  },

  showFolder(root) {
    try {
      Zotero.File.reveal(root);
    }
    catch (e) {
      Zotero.launchFile(root);
    }
  },
};
