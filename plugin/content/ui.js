/* global Zsync, Zotero, Services, ChromeUtils, PathUtils, IOUtils, Localization */
// Menus (collection context menu and Tools), the Settings pane, the
// "link a collection to a folder" flow and progress feedback.
var Zsync = globalThis.Zsync || {};
globalThis.Zsync = Zsync;

Zsync.ui = (() => {
  const FTL = "zsync.ftl";
  const PANE_ID = "zsync-prefpane";
  let pluginID = null;
  let l10n = null;

  function t(id, args) {
    try {
      if (!l10n) l10n = new Localization([FTL], true);
      return l10n.formatValueSync(id, args) || id;
    }
    catch (e) {
      return id;
    }
  }

  // ---- windows: menus take their labels from zsync.ftl, which each main
  // window has to load.
  function addToWindow(win) {
    try { win.MozXULElement.insertFTLIfNeeded(FTL); }
    catch (e) { Zotero.logError(e); }
  }

  function removeFromWindow(win) {
    win.document.querySelector(`link[rel="localization"][href="${FTL}"]`)?.remove();
  }

  // ---- which collection a menu was opened on. On Zotero 10 read
  // collectionTreeRows: its collectionTreeRow getter throws when several rows
  // are selected. On Zotero 9 only collectionTreeRow exists.
  function rowsFromContext(context) {
    if (!context) return [];
    if (Array.isArray(context.collectionTreeRows)) return context.collectionTreeRows;
    const row = context.collectionTreeRow;
    return row ? [row] : [];
  }

  function collectionFromContext(context) {
    const rows = rowsFromContext(context);
    return rows.length === 1 && rows[0].isCollection() ? rows[0].ref : null;
  }

  function windowOf(event, context) {
    return (event && event.target && event.target.ownerGlobal)
      || (context && context.menuElem && context.menuElem.ownerGlobal)
      || Zotero.getMainWindow();
  }

  function safely(win, promiseFn) {
    Promise.resolve().then(promiseFn).catch((e) => {
      Zotero.logError(e);
      Zotero.alert(win, "zsync", t("zsync-error-generic", { message: String((e && e.message) || e) }));
    });
  }

  function registerMenus() {
    Zotero.MenuManager.registerMenu({
      menuID: "zsync-collection",
      pluginID,
      target: "main/library/collection",
      menus: [
        {
          menuType: "menuitem",
          l10nID: "zsync-menu-export",
          onShowing: (event, context) => {
            context.setVisible(true);
            context.setEnabled(!!collectionFromContext(context));
          },
          onCommand: (event, context) => {
            const coll = collectionFromContext(context);
            const win = windowOf(event, context);
            if (coll) safely(win, () => exportCollection(coll, win));
          },
        },
        {
          menuType: "menuitem",
          l10nID: "zsync-menu-link",
          onShowing: (event, context) => {
            context.setVisible(true);
            context.setEnabled(!!collectionFromContext(context));
          },
          onCommand: (event, context) => {
            const coll = collectionFromContext(context);
            const win = windowOf(event, context);
            if (coll) {
              safely(win, async () => {
                const root = await linkCollection(coll, win);
                if (root) await exportRoots([root], win);
              });
            }
          },
        },
        {
          menuType: "menuitem",
          l10nID: "zsync-menu-unlink",
          onShowing: (event, context) => {
            const coll = collectionFromContext(context);
            context.setVisible(true);
            // also when some folder's link is not known yet (linked by an older zsync)
            const unknown = Zsync.config.roots().some((r) => !Zsync.config.identityOf(r));
            context.setEnabled(!!coll && (unknown || Zsync.config.rootsRememberedFor(coll).length > 0));
          },
          onCommand: (event, context) => {
            const coll = collectionFromContext(context);
            const win = windowOf(event, context);
            if (coll) safely(win, () => unlinkCollection(coll, win));
          },
        },
      ],
    });
    Zotero.MenuManager.registerMenu({
      menuID: "zsync-tools",
      pluginID,
      target: "main/menubar/tools",
      menus: [
        {
          menuType: "menuitem",
          l10nID: "zsync-menu-export-all",
          onCommand: (event, context) => {
            const win = windowOf(event, context);
            safely(win, () => exportAll(win));
          },
        },
      ],
    });
  }

  // ---- folder picking and linking
  async function pickFolder(win, title) {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const fp = new FilePicker();
    fp.init(win, title, fp.modeGetFolder);
    const rv = await fp.show();
    return rv === fp.returnOK ? fp.file : null;
  }

  // Link a collection to a project folder chosen by the person: create its
  // zsync.json, or adopt (or re-point) an existing one, and remember the
  // folder on this device. Returns the folder, or null if cancelled.
  async function linkCollection(collection, win) {
    const root = await pickFolder(win, t("zsync-pick-folder", { name: collection.name }));
    if (!root) return null;
    let existing;
    try {
      existing = await Zsync.config.read(root);
    }
    catch (e) {
      Zotero.alert(win, "zsync", t("zsync-error-config", { message: e.message }));
      return null;
    }
    const spec = Zsync.collect.librarySpecFor(collection.libraryID);
    if (!existing) {
      await Zsync.config.create(root, collection);
    }
    else if (existing.collection !== collection.key || existing.library !== spec) {
      const ok = Services.prompt.confirm(win, "zsync", t("zsync-confirm-relink", {
        folder: root, old: existing.name || existing.collection, name: collection.name,
      }));
      if (!ok) return null;
      await Zsync.config.relink(root, collection);
    }
    Zsync.config.addProject(root, await Zsync.config.read(root));
    return root;
  }

  // ---- unlinking (de-affiliating) a folder

  function nameOf(root) {
    const id = Zsync.config.identityOf(root);
    return (id && id.name) || PathUtils.filename(root);
  }

  // Ask how far to go, then stop exporting to root. Returns the unlink
  // report, or null if cancelled.
  async function unlinkInteractive(win, root) {
    // re-read the folder: what it is linked to now, not what was remembered
    let cfg = null;
    try { cfg = await Zsync.config.read(root); }
    catch (e) { cfg = null; }
    if (cfg) Zsync.config.rememberIdentity(root, cfg);
    const name = (cfg && (cfg.name || cfg.collection)) || nameOf(root);
    const checkbox = { value: false };
    const exists = await IOUtils.exists(root);
    const text = [t("zsync-unlink-question", { name }), root, exists ? t("zsync-unlink-explain") : t("zsync-unlink-gone")].join("\n\n");
    const button = Zotero.Prompt.confirm({
      window: win,
      title: t("zsync-unlink-title"),
      text,
      button0: t("zsync-unlink-keep"),
      button1: Services.prompt.BUTTON_TITLE_CANCEL,
      button2: exists ? t("zsync-unlink-delete") : null,
      checkLabel: exists && cfg ? t("zsync-unlink-config") : null,
      checkbox,
    });
    if (button === 1) return null;
    const deleteFiles = button === 2;
    let report;
    try {
      report = await Zsync.api.unlink(root, { deleteFiles, deleteConfig: !!checkbox.value });
    }
    catch (e) {
      Zotero.logError(e);
      Zotero.alert(win, t("zsync-unlink-title"), t("zsync-error-generic", { message: e.message }));
      return null;
    }
    const lines = [t("zsync-unlink-done", { folder: root })];
    if (deleteFiles) {
      if (report.noManifest) lines.push(t("zsync-unlink-nomanifest"));
      else lines.push(t("zsync-unlink-deleted", { count: report.deleted.length }));
      if (report.kept.length) lines.push(`${t("zsync-unlink-kept")}\n${report.kept.map((k) => `  ${k}`).join("\n")}`);
    }
    else if (report.deleted.includes(Zsync.config.FILE)) {
      lines.push(t("zsync-unlink-config-deleted"));
    }
    if (report.failed && report.failed.length) lines.push(`${t("zsync-unlink-failed")}\n${report.failed.map((k) => `  ${k}`).join("\n")}`);
    if (report.error) lines.push(t("zsync-error-generic", { message: report.error }));
    Zotero.alert(win, t("zsync-unlink-title"), lines.join("\n\n"));
    return report;
  }

  async function chooseRoot(win, title, text, roots) {
    if (roots.length === 1) return roots[0];
    const selected = { value: 0 };
    return Services.prompt.select(win, title, text, roots, selected) ? roots[selected.value] : null;
  }

  async function unlinkCollection(collection, win) {
    // refresh what each registered folder is linked to before choosing
    await Zsync.config.projects();
    const roots = Zsync.config.rootsRememberedFor(collection);
    if (!roots.length) {
      Zotero.alert(win, "zsync", t("zsync-unlink-none", { name: collection.name }));
      return null;
    }
    const root = await chooseRoot(win, t("zsync-unlink-title"), t("zsync-unlink-choose", { name: collection.name }), roots);
    return root ? unlinkInteractive(win, root) : null;
  }

  // ---- folders that were renamed or moved

  // Look for a missing folder's new location and, with the person's say-so,
  // switch to it. The person can always choose the folder themselves.
  // Returns the folder to export to, or null.
  async function findInteractive(win, root) {
    const name = nameOf(root);
    const found = await Zsync.api.findMoved(root);
    if (found.back) {
      await Zsync.api.relocate(root, root);
      return root;
    }
    const intro = [t("zsync-missing-question", { name }), root];
    let target = null;
    let choose = false;
    if (found.volumeMissing) {
      const button = Zotero.Prompt.confirm({
        window: win, title: "zsync",
        text: [...intro, t("zsync-found-unplugged", { drive: found.volumeMissing })].join("\n\n"),
        button0: t("zsync-found-choose"), button1: Services.prompt.BUTTON_TITLE_CANCEL,
      });
      if (button !== 0) return null;
      choose = true;
    }
    else if (found.candidates.length === 1) {
      const button = Zotero.Prompt.confirm({
        window: win, title: "zsync",
        text: [...intro, t("zsync-found-one"), found.candidates[0]].join("\n\n"),
        button0: t("zsync-found-use"), button1: Services.prompt.BUTTON_TITLE_CANCEL, button2: t("zsync-found-choose"),
      });
      if (button === 1) return null;
      if (button === 0) target = found.candidates[0];
      else choose = true;
    }
    else if (found.candidates.length > 1) {
      const options = [...found.candidates, t("zsync-found-choose")];
      const selected = { value: 0 };
      if (!Services.prompt.select(win, "zsync", t("zsync-found-many", { name }), options, selected)) return null;
      if (selected.value < found.candidates.length) target = found.candidates[selected.value];
      else choose = true;
    }
    else {
      const text = [...intro, found.identity ? t("zsync-found-none") : t("zsync-found-unknown")].join("\n\n");
      if (!Services.prompt.confirm(win, "zsync", text)) return null;
      choose = true;
    }
    if (choose) {
      target = await pickFolder(win, t("zsync-pick-moved", { name }));
      if (!target) return null;
    }
    try {
      await Zsync.api.relocate(root, target);
    }
    catch (e) {
      Zotero.alert(win, "zsync", e.message);
      return null;
    }
    return target;
  }

  // A registered folder has gone missing: find it, skip it, or unlink it.
  async function resolveMissing(win, root) {
    const button = Zotero.Prompt.confirm({
      window: win,
      title: "zsync",
      text: [t("zsync-missing-question", { name: nameOf(root) }), root, t("zsync-missing-explain")].join("\n\n"),
      button0: t("zsync-missing-find"),
      button1: t("zsync-missing-skip"),
      button2: t("zsync-missing-unlink"),
    });
    if (button === 0) return findInteractive(win, root);
    if (button === 2) await Zsync.api.unlink(root);
    return null;
  }

  // ---- exporting with feedback

  // An automatic export failed, so nobody saw it happen: say so in a corner
  // window that closes by itself. Settings → zsync keeps the message.
  // Returns whether there was a Zotero window to say it in.
  function notifyAutoFailure(root, message) {
    const win = Zotero.getMainWindow();
    if (!win) return false;
    const pw = new Zotero.ProgressWindow({ window: win, closeOnClick: true });
    pw.changeHeadline(t("zsync-auto-failed", { name: nameOf(root) }));
    pw.addDescription(message);
    pw.show();
    pw.startCloseTimer(15000);
    return true;
  }

  function summary(report) {
    const n = report.changed.length + report.removed.length;
    const lines = [n ? t("zsync-done-changed", { count: n }) : t("zsync-done-unchanged")];
    for (const w of report.warnings.slice(0, 3)) lines.push(`⚠ ${w}`);
    if (report.warnings.length > 3) lines.push(t("zsync-more-warnings", { count: report.warnings.length - 3 }));
    return lines;
  }

  async function exportRoots(roots, win) {
    const reports = [];
    for (const root of roots) {
      // unlinked while this batch was running
      if (!Zsync.config.roots().some((r) => Zsync.config.sameFolder(r, root))) continue;
      const pw = new Zotero.ProgressWindow({ window: win || Zotero.getMainWindow(), closeOnClick: true });
      pw.changeHeadline(t("zsync-exporting"), null, PathUtils.filename(root));
      pw.show();
      try {
        const report = await Zsync.exporter.run(root);
        Zsync.auto.remember(root, report);
        reports.push(report);
        pw.changeHeadline(t("zsync-exported", { name: report.name }));
        for (const line of summary(report)) pw.addDescription(line);
        pw.startCloseTimer(report.warnings.length ? 8000 : 3500);
      }
      catch (e) {
        Zsync.auto.failed(root, e);
        Zotero.logError(e);
        pw.changeHeadline(t("zsync-failed"));
        pw.addDescription(String((e && e.message) || e));
        pw.startCloseTimer(12000);
      }
    }
    return reports;
  }

  async function exportCollection(collection, win) {
    const roots = (await Zsync.config.projectsFor(collection)).map((p) => p.root);
    // folders linked to this collection that have gone missing
    const remembered = Zsync.config.rootsRememberedFor(collection);
    let askedAboutMissing = false;
    for (const p of await Zsync.config.projects()) {
      if (!p.missing || !remembered.some((r) => Zsync.config.sameFolder(r, p.root))) continue;
      askedAboutMissing = true;
      const found = await resolveMissing(win, p.root);
      if (found && !roots.some((r) => Zsync.config.sameFolder(r, found))) roots.push(found);
    }
    // Skip, Esc or Unlink on a missing folder is an answer, not a request
    // to link a new one
    if (!roots.length && askedAboutMissing) return [];
    if (!roots.length) {
      const root = await linkCollection(collection, win);
      if (!root) return [];
      roots.push(root);
    }
    return exportRoots(roots, win);
  }

  async function exportAll(win) {
    const projects = await Zsync.config.projects();
    if (!projects.length) {
      Zotero.alert(win, "zsync", t("zsync-no-projects"));
      return [];
    }
    const broken = projects.filter((p) => !p.cfg);
    for (const p of broken) Zsync.auto.failed(p.root, p.error);
    const reports = await exportRoots(projects.filter((p) => p.cfg).map((p) => p.root), win);
    if (broken.length) {
      const lines = broken.map((p) => `${p.root}: ${p.error}`);
      if (broken.some((p) => p.missing)) lines.push("", t("zsync-missing-hint"));
      Zotero.alert(win, "zsync", lines.join("\n"));
    }
    return reports;
  }

  // ---- settings pane
  async function registerPane(rootURI) {
    await Zotero.PreferencePanes.register({
      pluginID,
      id: PANE_ID,
      label: "zsync",
      src: rootURI + "prefs/zsync-prefs.xhtml",
      scripts: [rootURI + "prefs/zsync-prefs.js"],
      stylesheets: [rootURI + "prefs/zsync-prefs.css"],
    });
  }

  async function startup({ id, rootURI }) {
    pluginID = id;
    l10n = null;
    for (const win of Zotero.getMainWindows()) addToWindow(win);
    registerMenus();
    await registerPane(rootURI);
  }

  // Menus and the pane are removed by Zotero when the plugin shuts down;
  // only the Fluent links are ours to remove.
  function shutdown() {
    for (const win of Zotero.getMainWindows()) removeFromWindow(win);
    l10n = null;
  }

  return {
    startup, shutdown, addToWindow, removeFromWindow, t, pickFolder,
    linkCollection, exportCollection, exportRoots, exportAll, collectionFromContext,
    unlinkInteractive, unlinkCollection, findInteractive, resolveMissing, notifyAutoFailure, PANE_ID,
  };
})();
