/* global document, window, Zotero */
// The zsync Settings pane. Runs in its own sandbox (window is its prototype);
// the markup reaches it through Zotero_Preferences.getScope("zsync-prefpane").
var ZsyncPrefs = {
  timer: null,

  init() {
    document.getElementById("zsync-add").addEventListener("command", () => this.add());
    document.getElementById("zsync-export-all").addEventListener("command", () => this.exportRoots(this.api().roots()));
    this.render();
    // results of automatic exports appear without reopening Settings
    this.timer = window.setInterval(() => this.render(), 5000);
  },

  uninit() {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
  },

  api() {
    if (!Zotero.Zsync) throw new Error("zsync is not running");
    return Zotero.Zsync;
  },

  el(tag, attrs = {}, text) {
    const e = tag.includes(":")
      ? document.createXULElement(tag.split(":")[1])
      : document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  },

  async status(root, p) {
    const api = this.api();
    const last = api.lastResult(root);
    if (p && !p.cfg) return { cls: "error", text: api.t("zsync-prefs-status-missing", { message: p.error }) };
    if (!last) return { cls: "", text: api.t("zsync-prefs-status-never") };
    if (last.error) return { cls: "error", text: api.t("zsync-prefs-status-error", { message: last.error }) };
    const c = last.report.counts || {};
    const when = new Date(last.at).toLocaleString();
    let text = api.t(last.auto ? "zsync-prefs-status-auto" : "zsync-prefs-status-ok", { when, items: c.items || 0, annotations: c.annotations || 0 });
    if (last.report.warnings.length) text += ` · ⚠ ${last.report.warnings.length}`;
    return { cls: last.report.warnings.length ? "warn" : "ok", text, title: last.report.warnings.join("\n") };
  },

  async render() {
    let api;
    try { api = this.api(); }
    catch (e) { return; }
    const box = document.getElementById("zsync-projects");
    if (!box) return;
    const rows = [];
    const projects = await api.projects();
    for (const root of api.roots()) {
      const p = projects.find((x) => x.root === root);
      const row = this.el("div", { class: "zsync-project" });
      const info = this.el("div", { class: "zsync-info" });
      info.append(this.el("div", { class: "zsync-path" }, root));
      const st = await this.status(root, p);
      const s = this.el("div", { class: `zsync-status ${st.cls}` }, st.text);
      if (st.title) s.setAttribute("title", st.title);
      info.append(s);
      row.append(info);
      const buttons = this.el("xul:hbox", { class: "zsync-row-buttons" });
      const actions = p && p.missing
        ? [["zsync-prefs-find", () => this.find(root)], ["zsync-prefs-remove", () => this.remove(root)]]
        : [["zsync-prefs-export", () => this.exportRoots([root])], ["zsync-prefs-show", () => api.showFolder(root)], ["zsync-prefs-remove", () => this.remove(root)]];
      for (const [id, fn] of actions) {
        const b = this.el("xul:button", { "data-l10n-id": id });
        b.addEventListener("command", fn);
        buttons.append(b);
      }
      row.append(buttons);
      rows.push(row);
    }
    if (!rows.length) rows.push(this.el("p", { class: "zsync-help", "data-l10n-id": "zsync-prefs-empty" }));
    box.replaceChildren(...rows);
  },

  async add() {
    const api = this.api();
    const root = await api.pickFolder(window, "zsync");
    if (!root) return;
    let cfg;
    try {
      cfg = await api.readConfig(root);
    }
    catch (e) {
      Zotero.alert(window, "zsync", api.t("zsync-error-config", { message: e.message }));
      return;
    }
    if (!cfg) {
      Zotero.alert(window, "zsync", api.t("zsync-prefs-no-config", { folder: root }));
      return;
    }
    api.addProject(root, cfg);
    await this.render();
    await this.exportRoots([root]);
  },

  async remove(root) {
    try {
      await this.api().unlinkInteractive(window, root);
    }
    catch (e) {
      Zotero.alert(window, "zsync", String((e && e.message) || e));
    }
    finally {
      this.render();
    }
  },

  async find(root) {
    try {
      await this.api().findInteractive(window, root);
    }
    finally {
      this.render();
    }
  },

  async exportRoots(roots) {
    try {
      await this.api().exportRoots(roots, window);
    }
    finally {
      this.render();
    }
  },
};
