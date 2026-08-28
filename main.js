'use strict';
/*
 * Deborah Remote — Obsidian plugin (mobile + desktop)
 *
 *  1. Native stream view  : renders the live Claude-session prose from the
 *     todaystream service (SSE) inside an Obsidian pane, with a type-back box.
 *  2. Remote-control channel: holds an SSE connection to todaystream /cmd/stream
 *     and executes commands d2 pushes — open notes, flip Reading mode, run any
 *     command, edit the vault (full control). Acks results back.
 *
 *  Config (Settings → Deborah Remote): base URL + bearer. The bearer is stored
 *  only in this device's plugin data (never synced, never committed). It is
 *  effectively a root key — the command channel can edit your vault.
 *
 *  Plain CommonJS so it loads with no build step. Requires Obsidian 1.4+.
 */
const obsidian = require('obsidian');
const { Plugin, ItemView, Notice, MarkdownView, PluginSettingTab, Setting, requestUrl } = obsidian;

const VIEW_TYPE = 'deborah-stream-view';

const DEFAULTS = {
  baseUrl: 'https://deborah-2.tail1fd1c8.ts.net/todaystream',
  bearer: '',
  remoteControl: true,
};

function trimBase(u) { return (u || '').replace(/\/+$/, ''); }

// Obsidian's markdown render helper moved between versions; support both.
async function renderMd(app, md, el, component) {
  try {
    if (obsidian.MarkdownRenderer && obsidian.MarkdownRenderer.render) {
      await obsidian.MarkdownRenderer.render(app, md, el, '', component);
      return;
    }
  } catch (e) { /* fall through */ }
  await obsidian.MarkdownRenderer.renderMarkdown(md, el, '', component);
}

/* ----------------------------------------------------------- stream view -- */
class StreamView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.es = null;
    this.live = false;
    this.lastAssistantEl = null;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Today Stream"; }
  getIcon() { return "radio"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('dbr-root');

    const bar = root.createDiv('dbr-bar');
    this.dot = bar.createSpan('dbr-dot');
    bar.createSpan({ text: "Today's Note", cls: 'dbr-title' });
    this.status = bar.createSpan({ text: 'connecting…', cls: 'dbr-status' });

    this.feed = root.createDiv('dbr-feed');

    const foot = root.createDiv('dbr-foot');
    this.box = foot.createEl('textarea', { cls: 'dbr-box', attr: { rows: '1', placeholder: 'type back to the session…' } });
    this.sendBtn = foot.createEl('button', { text: 'Send', cls: 'dbr-send' });
    this.sendBtn.onclick = () => this.send();
    this.box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    });

    this.connect();
  }

  async onClose() { this.disconnect(); }

  connect() {
    this.disconnect();
    const base = trimBase(this.plugin.settings.baseUrl);
    const bearer = this.plugin.settings.bearer;
    if (!bearer) { this.setStatus('no bearer — set it in settings', true); return; }
    const url = base + '/stream?bearer=' + encodeURIComponent(bearer);
    try {
      this.es = new EventSource(url);
    } catch (e) { this.setStatus('connect failed', true); return; }
    this.es.onopen = () => { this.dot.addClass('live'); this.setStatus('live'); };
    this.es.onerror = () => { this.dot.removeClass('live'); this.setStatus('reconnecting…'); };
    this.es.onmessage = (e) => { try { this.onEvent(JSON.parse(e.data)); } catch (_) {} };
  }
  disconnect() { if (this.es) { this.es.close(); this.es = null; } }

  setStatus(t, err) { if (this.status) { this.status.setText(t); this.status.toggleClass('dbr-err', !!err); } }

  atBottom() { return this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 90; }
  scroll() { this.feed.scrollTop = this.feed.scrollHeight; }

  onEvent(ev) {
    if (!ev || ev.kind === 'ping') return;
    const stick = this.atBottom();
    if (ev.kind === 'sys') {
      if (ev.content === '— live —') this.live = true;
      const d = this.feed.createDiv('dbr-sys'); d.setText(ev.content);
    } else if (ev.kind === 'user') {
      const d = this.feed.createDiv('dbr-msg dbr-user');
      d.createDiv({ cls: 'dbr-who', text: 'Sebastian' });
      const body = d.createDiv('dbr-md');
      renderMd(this.app, ev.content, body, this);
      this.lastAssistantEl = null;
    } else if (ev.kind === 'tool') {
      let host = this.lastAssistantEl;
      if (!host) { host = this.feed.createDiv('dbr-msg dbr-assistant'); host.createDiv({ cls: 'dbr-who', text: 'Deborah' }); this.lastAssistantEl = host; }
      const chip = host.createSpan('dbr-chip');
      chip.createSpan({ cls: 'dbr-chip-name', text: '⚙ ' + (ev.name || 'tool') });
      if (ev.content) chip.createSpan({ text: ' · ' + ev.content });
    } else if (ev.kind === 'text') {
      const d = this.feed.createDiv('dbr-msg dbr-assistant dbr-fade');
      d.createDiv({ cls: 'dbr-who', text: 'Deborah' });
      const body = d.createDiv('dbr-md');
      renderMd(this.app, ev.content, body, this);
      this.lastAssistantEl = d;
    }
    if (stick) this.scroll();
  }

  async send() {
    const text = (this.box.value || '').trim();
    if (!text) return;
    this.sendBtn.disabled = true;
    try {
      const base = trimBase(this.plugin.settings.baseUrl);
      const r = await requestUrl({
        url: base + '/send?bearer=' + encodeURIComponent(this.plugin.settings.bearer),
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), throw: false,
      });
      if (r.status === 200) { this.box.value = ''; }
      else { this.setStatus('send failed (' + r.status + ')', true); }
    } catch (e) { this.setStatus('send error', true); }
    this.sendBtn.disabled = false;
  }
}

/* --------------------------------------------------------------- plugin --- */
module.exports = class DeborahRemote extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.cmdEs = null;
    this.cmdRetry = null;

    this.registerView(VIEW_TYPE, (leaf) => new StreamView(leaf, this));
    this.addRibbonIcon('radio', 'Today Stream', () => this.activateStreamView());
    this.addCommand({ id: 'open-today-stream', name: 'Open Today Stream', callback: () => this.activateStreamView() });
    this.addCommand({ id: 'reconnect-remote', name: 'Reconnect remote-control channel', callback: () => this.connectCmd() });
    this.addSettingTab(new SettingsTab(this.app, this));

    if (this.settings.remoteControl) this.connectCmd();
  }

  onunload() { this.disconnectCmd(); }

  async activateStreamView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = (workspace.getRightLeaf(false) || workspace.getLeaf(true));
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /* ---- remote-control command channel ---- */
  connectCmd() {
    this.disconnectCmd();
    const base = trimBase(this.settings.baseUrl);
    const bearer = this.settings.bearer;
    if (!bearer) return;
    const url = base + '/cmd/stream?bearer=' + encodeURIComponent(bearer);
    try { this.cmdEs = new EventSource(url); } catch (e) { this.scheduleCmdRetry(); return; }
    this.cmdEs.onmessage = (e) => { let c; try { c = JSON.parse(e.data); } catch (_) { return; } this.execute(c); };
    this.cmdEs.onerror = () => { /* EventSource auto-reconnects; guard anyway */ };
  }
  disconnectCmd() { if (this.cmdEs) { this.cmdEs.close(); this.cmdEs = null; } if (this.cmdRetry) { clearTimeout(this.cmdRetry); this.cmdRetry = null; } }
  scheduleCmdRetry() { if (this.cmdRetry) return; this.cmdRetry = setTimeout(() => { this.cmdRetry = null; this.connectCmd(); }, 4000); }

  async ack(id, ok, result) {
    if (id == null) return;
    try {
      const base = trimBase(this.settings.baseUrl);
      await requestUrl({
        url: base + '/cmd/ack?bearer=' + encodeURIComponent(this.settings.bearer),
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ok, result: result == null ? null : String(result).slice(0, 500) }),
        throw: false,
      });
    } catch (_) {}
  }

  fileByPath(path) {
    const af = this.app.vault.getAbstractFileByPath(path);
    return (af && af instanceof obsidian.TFile) ? af : null;
  }

  async execute(cmd) {
    if (!cmd || cmd.op === 'hello') return;
    const app = this.app;
    try {
      switch (cmd.op) {
        case 'notice':
          new Notice(String(cmd.msg || ''));
          break;
        case 'open':
          await app.workspace.openLinkText(cmd.path || '', '', !!cmd.newLeaf);
          if (cmd.mode) await this.setMode(cmd.mode);
          break;
        case 'openstream':
          await this.activateStreamView();
          break;
        case 'mode':
          await this.setMode(cmd.mode);
          break;
        case 'command':
          app.commands.executeCommandById(cmd.id);
          break;
        case 'create': {
          const ex = this.fileByPath(cmd.path);
          if (ex) await app.vault.modify(ex, cmd.content || '');
          else await app.vault.create(cmd.path, cmd.content || '');
          break;
        }
        case 'modify': {
          const f = this.fileByPath(cmd.path);
          if (!f) throw new Error('no such file: ' + cmd.path);
          await app.vault.modify(f, cmd.content || '');
          break;
        }
        case 'append': {
          let f = this.fileByPath(cmd.path);
          if (!f) f = await app.vault.create(cmd.path, '');
          await app.vault.append(f, cmd.text || '');
          break;
        }
        case 'delete': {
          const f = this.fileByPath(cmd.path);
          if (f) await app.vault.trash(f, true);
          break;
        }
        case 'eval': {
          // full control — arbitrary JS with app + plugin + obsidian in scope
          const fn = new Function('app', 'plugin', 'obsidian', '"use strict";return (async()=>{' + (cmd.js || '') + '})()');
          const out = await fn(app, this, obsidian);
          await this.ack(cmd.id, true, out);
          return;
        }
        default:
          throw new Error('unknown op: ' + cmd.op);
      }
      await this.ack(cmd.id, true, 'ok');
    } catch (e) {
      await this.ack(cmd.id, false, e && e.message ? e.message : String(e));
      new Notice('Deborah Remote: ' + (e && e.message ? e.message : e));
    }
  }

  async setMode(mode) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const state = view.getState();
    state.mode = (mode === 'reading' || mode === 'preview') ? 'preview' : 'source';
    await view.setState(state, {});
  }

  async saveSettings() { await this.saveData(this.settings); }
};

/* --------------------------------------------------------------- settings - */
class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: 'Deborah Remote' });

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('todaystream service on the tailnet, no trailing slash.')
      .addText((t) => t.setPlaceholder('https://deborah-2.tail1fd1c8.ts.net/todaystream')
        .setValue(this.plugin.settings.baseUrl)
        .onChange(async (v) => { this.plugin.settings.baseUrl = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Bearer')
      .setDesc('Root key — stored only on this device, never synced. The command channel can edit your vault.')
      .addText((t) => { t.inputEl.type = 'password'; t.setPlaceholder('paste bearer')
        .setValue(this.plugin.settings.bearer)
        .onChange(async (v) => { this.plugin.settings.bearer = v.trim(); await this.plugin.saveSettings(); }); });

    new Setting(containerEl)
      .setName('Remote control')
      .setDesc('Let d2 open notes, flip Reading mode, run commands, and edit the vault. Turn off for stream-view only.')
      .addToggle((tg) => tg.setValue(this.plugin.settings.remoteControl)
        .onChange(async (v) => {
          this.plugin.settings.remoteControl = v; await this.plugin.saveSettings();
          if (v) this.plugin.connectCmd(); else this.plugin.disconnectCmd();
        }));

    new Setting(containerEl).addButton((b) => b.setButtonText('Reconnect').onClick(() => { this.plugin.connectCmd(); new Notice('Deborah Remote: reconnecting'); }));
  }
}
