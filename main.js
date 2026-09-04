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
const { Plugin, ItemView, Notice, MarkdownView, PluginSettingTab, Setting, FuzzySuggestModal, requestUrl } = obsidian;

const VIEW_TYPE = 'deborah-stream-view';

const DEFAULTS = {
  baseUrl: 'https://deborah-2.tail1fd1c8.ts.net/todaystream',
  bearer: '',
  remoteControl: true,
  // Per-DEVICE label, generated once on first load and then persisted. See ensureClientId().
  clientId: '',
  // Fenced 2026-08-30. `eval` runs arbitrary JS pushed from d2 (a NON-PHI box) inside
  // this vault. Default-deny: the op is refused unless this is explicitly turned on in
  // Settings, and it does not persist any grant beyond that toggle.
  allowEval: false,
};

// Explicit allow-list. Anything not named here is refused, so a future op added
// upstream is denied by default rather than silently granted.
const ALLOWED_OPS = ['hello', 'notice', 'open', 'openstream', 'mode', 'command',
                     'create', 'modify', 'append', 'delete'];

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

/* ------------------------------------------------------- slice picker --- */
// Shown only when the active note's folder matches no slice scope. Slices come
// from d2's registry, so a slice added there needs no plugin change here.
class SlicePicker extends FuzzySuggestModal {
  constructor(app, names, onPick) { super(app); this.names = names; this.onPick = onPick; this.setPlaceholder('Send selection to which slice?'); }
  getItems() { return this.names; }
  getItemText(n) { return n; }
  onChooseItem(n) { this.onPick(n); }
}

/* --------------------------------------------------------------- plugin --- */
module.exports = class DeborahRemote extends Plugin {
  // Several surfaces (Mac, iPad) hold the command channel open at once. A push
  // therefore fans out to all of them and an ack used to come back anonymous, so
  // when a pushed command ran on the iPad rather than the Mac the ack could not
  // say so. Each device now labels itself; the label is generated ONCE and
  // persisted in data.json, which is per-device and gitignored, so the Mac and
  // the iPad never end up sharing one.
  ensureClientId() {
    if (this.settings.clientId) return this.settings.clientId;
    const P = (obsidian && obsidian.Platform) || {};
    const kind = P.isIosApp ? 'ios' : P.isAndroidApp ? 'android'
      : P.isMacOS ? 'mac' : P.isWin ? 'win' : P.isLinux ? 'linux'
      : P.isMobile ? 'mobile' : 'desktop';
    let rand = '';
    try {
      const b = new Uint8Array(2);
      crypto.getRandomValues(b);
      rand = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      rand = Math.floor(Math.random() * 65536).toString(16).padStart(4, '0');
    }
    this.settings.clientId = kind + '-' + rand;
    // Fire-and-forget: a failed save just means a new label next launch, which is
    // cosmetic. Never block startup on it.
    this.saveSettings().catch(() => {});
    return this.settings.clientId;
  }

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.ensureClientId();
    this.cmdEs = null;
    this.cmdRetry = null;

    this.registerView(VIEW_TYPE, (leaf) => new StreamView(leaf, this));
    this.addRibbonIcon('radio', 'Today Stream', () => this.activateStreamView());
    this.addCommand({ id: 'open-today-stream', name: 'Open Today Stream', callback: () => this.activateStreamView() });
    this.addCommand({ id: 'reconnect-remote', name: 'Reconnect remote-control channel', callback: () => this.connectCmd() });
    // A DEFAULT HOTKEY IS LOAD-BEARING, not a convenience: invoking this from the
    // command palette collapses the editor selection, so getSelection() comes back
    // empty and the router refuses. Fire it with the hotkey, never via Cmd+P.
    this.addCommand({ id: 'send-selection-to-slice', name: 'Send selection to slice pane',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'K' }],
      editorCallback: (editor, view) => this.sendSelectionToSlice(editor, view) });
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
    const url = base + '/cmd/stream?bearer=' + encodeURIComponent(bearer)
      + '&client=' + encodeURIComponent(this.ensureClientId());
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
        body: JSON.stringify({ id, ok, client: this.ensureClientId(),
                                result: result == null ? null : String(result).slice(0, 500) }),
        throw: false,
      });
    } catch (_) {}
  }

  /* ---- selection -> slice pane (master-slave phase-1 step 3) ---- */
  // The registry lives on d2; we cache it for the session so the common path is
  // one request, and fall back to the picker whenever the scope match is unclear.
  async fetchSlices() {
    if (this._slices) return this._slices;
    const base = trimBase(this.settings.baseUrl);
    const r = await requestUrl({
      url: base + '/slice/list?bearer=' + encodeURIComponent(this.settings.bearer),
      method: 'GET', throw: false,
    });
    if (r.status !== 200) throw new Error('slice list ' + r.status);
    this._slices = (r.json && r.json.slices) || {};
    this._phiPaths = (r.json && r.json.phi_paths) || [];
    return this._slices;
  }

  // Longest matching scope wins, so 02-Areas/Personal-Development beats 02-Areas.
  // A tie means two slices claim the note equally (05-Daily feeds both magic and
  // personal) — that is genuinely ambiguous, so we return null and ask.
  resolveSlice(slices, path) {
    let best = null, bestLen = -1, tied = false;
    for (const [name, cfg] of Object.entries(slices)) {
      for (const scope of (cfg.vault_scopes || [])) {
        if (!scope) continue;
        if (path !== scope && !path.startsWith(scope + '/')) continue;
        if (scope.length > bestLen) { best = name; bestLen = scope.length; tied = false; }
        else if (scope.length === bestLen && name !== best) { tied = true; }
      }
    }
    return tied ? null : best;
  }

  async sendSelectionToSlice(editor, view) {
    const text = (editor.getSelection() || '').trim();
    if (!text) { new Notice('Deborah: select some text first'); return; }

    let slices;
    try { slices = await this.fetchSlices(); }
    catch (e) { new Notice('Deborah: cannot reach d2 (' + e.message + ')'); return; }

    const names = Object.keys(slices);
    if (!names.length) { new Notice('Deborah: no slices registered'); return; }

    const path = (view && view.file && view.file.path) || '';
    if (!path) { new Notice('Deborah: save the note first (the PHI fence needs its path)'); return; }
    // Refuse before it leaves the machine. d2 refuses again on the same list —
    // this copy only saves a round-trip and gives a clearer message.
    if ((this._phiPaths || []).some((pre) => path === pre || path.startsWith(pre + '/'))) {
      new Notice('Deborah: ' + path + ' is PHI-fenced — not routed'); return;
    }

    const guess = this.resolveSlice(slices, path);
    if (guess) { this.postSlice(guess, text, path); return; }
    new SlicePicker(this.app, names, (n) => this.postSlice(n, text, path)).open();
  }

  async postSlice(name, text, path) {
    const base = trimBase(this.settings.baseUrl);
    let r;
    try {
      r = await requestUrl({
        url: base + '/slice/send?bearer=' + encodeURIComponent(this.settings.bearer),
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slice: name, text, path }), throw: false,
      });
    } catch (e) { new Notice('Deborah: send failed (' + e.message + ')'); return; }

    const j = r.json || {};
    if (r.status === 200 && j.ok) { new Notice('→ ' + name + ' (' + j.chars + ' chars)'); return; }
    if (r.status === 409) { new Notice('Deborah: ' + name + ' is still answering'); return; }
    new Notice('Deborah: ' + (j.err || ('HTTP ' + r.status)));
  }

  fileByPath(path) {
    const af = this.app.vault.getAbstractFileByPath(path);
    return (af && af instanceof obsidian.TFile) ? af : null;
  }

  async execute(cmd) {
    if (!cmd || cmd.op === 'hello') return;
    const app = this.app;

    // --- fence -------------------------------------------------------------
    if (cmd.op === 'eval' && !this.settings.allowEval) {
      await this.ack(cmd.id, false, 'refused: eval is fenced (Settings -> Deborah Remote -> Allow eval)');
      new Notice('Deborah Remote: refused a pushed eval (fenced)');
      return;
    }
    if (cmd.op !== 'eval' && !ALLOWED_OPS.includes(cmd.op)) {
      await this.ack(cmd.id, false, 'refused: op not in allow-list');
      return;
    }
    // -----------------------------------------------------------------------
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
        case 'command': {
          // `id` is the channel's own ack correlation id — the service stamps an
          // integer over whatever the caller put there, so the command to run has
          // to travel in its own field.
          const cid = cmd.command_id;
          if (!cid) throw new Error('command needs command_id');
          if (!app.commands.executeCommandById(cid)) throw new Error('no such command: ' + cid);
          break;
        }
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

  async saveSettings() { this._slices = null; this._phiPaths = null; await this.saveData(this.settings); }
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
      .setName('Device label')
      .setDesc('Identifies THIS surface on the command channel, so a push says which '
             + 'device ran it. Generated once and persisted per device. Clear the field '
             + 'to have a new one issued on the next reconnect.')
      .addText((t) => { t.setPlaceholder('auto')
        .setValue(this.plugin.settings.clientId || '')
        .onChange(async (v) => {
          this.plugin.settings.clientId = v.trim();
          await this.plugin.saveSettings();
          this.plugin.ensureClientId();
          if (this.plugin.settings.remoteControl) this.plugin.connectCmd();
        }); });

    new Setting(containerEl)
      .setName('Remote control')
      .setDesc('Let d2 open notes, flip Reading mode, run commands, and edit the vault. Turn off for stream-view only.')
      .addToggle((tg) => tg.setValue(this.plugin.settings.remoteControl)
        .onChange(async (v) => {
          this.plugin.settings.remoteControl = v; await this.plugin.saveSettings();
          if (v) this.plugin.connectCmd(); else this.plugin.disconnectCmd();
        }));

    new Setting(containerEl)
      .setName('Allow eval (dangerous)')
      .setDesc('Off by default. When on, d2 can execute arbitrary JavaScript in this vault \u2014 '
             + 'it can read any note and send 500 characters back per call. Turn on only for a '
             + 'specific task, then turn it off. Every other remote op keeps working while this is off.')
      .addToggle((tg) => tg.setValue(this.plugin.settings.allowEval)
        .onChange(async (v) => {
          this.plugin.settings.allowEval = v; await this.plugin.saveSettings();
          new Notice(v ? 'Deborah Remote: eval ENABLED' : 'Deborah Remote: eval fenced');
        }));

    new Setting(containerEl).addButton((b) => b.setButtonText('Reconnect').onClick(() => { this.plugin.connectCmd(); new Notice('Deborah Remote: reconnecting'); }));
  }
}
