'use strict';
// Wave Link 3 Universal - by ShkourBashtawi.
// Main changes:
//  - Key images / states are only sent to Control Deck when they actually change.
//  - Key presses are sent to Wave Link immediately, never waiting for a reply;
//    presses <30 ms apart on one target are merged (latest value wins).
//  - Periodic refresh never overwrites a value you just changed (quiet window).
//  - Only one refresh runs at a time; physical devices are refreshed less often.
//  - Wave Link reconnects with back-off, also when it was closed at startup.
//  - Catalog goes to the settings panel directly instead of being written into
//    every key's saved settings.
//  - The process exits when Control Deck closes the connection (no orphan node.exe).
//  - Global error guards: one bad message can't kill the plugin.
const fs = require('fs');
const path = require('path');
const { SimpleWS } = require('./ws');

const CFG = {
  pollMs: 1500,          // background sync with Wave Link
  deviceEvery: 5,        // refresh physical devices every N polls (unless a key uses them)
  writeQuietMs: 700,     // ignore polled data this long after a key press
  notifyDebounceMs: 150, // Wave Link push notification -> refresh
  rpcTimeoutMs: 4000,
  writeMinGapMs: 30,     // per target: at most one write every 30 ms (latest value wins)
  openTimeoutMs: 5000,
  reconnectMinMs: 1000,
  reconnectMaxMs: 5000,
  repeatDelayMs: 350,
  repeatEveryMs: 100,
  repeatMaxMs: 10000,    // safety stop if keyUp is never received
};

const LOG_FILE = path.join(__dirname, '..', 'wavelink3.log');
try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch {}
const log = (...a) => {
  const line = new Date().toISOString() + ' ' + a.map(x => typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x)).join(' ');
  try { console.error(line); } catch {}
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
};
process.on('uncaughtException', e => log('uncaught:', (e && e.stack) || e));
process.on('unhandledRejection', e => log('unhandled:', (e && e.message) || e));

const ACTIONS = {
  'com.costner.wavelink3.mute': { name: 'Mute / Unmute', kind: 'mute', icon: 'mic' },
  'com.costner.wavelink3.volumeup': { name: 'Volume +', kind: 'volume', delta: .1, sign: 'plus', icon: 'volume-up' },
  'com.costner.wavelink3.volumedown': { name: 'Volume −', kind: 'volume', delta: -.1, sign: 'minus', icon: 'volume-down' },
  'com.costner.wavelink3.inputstatus': { name: 'Input / Entrada', kind: 'status', statusIcon: 'input', defaultType: 'channel' },
  'com.costner.wavelink3.outputstatus': { name: 'Output / Saída', kind: 'status', statusIcon: 'output', defaultType: 'channelSend' },
  'com.costner.wavelink3.auxstatus': { name: 'AUX / Mix', kind: 'status', statusIcon: 'aux', defaultType: 'channelSend' },
};

// ---------------------------------------------------------------- Control Deck
class StreamDock {
  constructor() { this.ws = null; this.port = null; this.uuid = null; this.register = null; this.handlers = {}; }
  on(e, f) { this.handlers[e] = f; return this; }
  connect() {
    const a = process.argv.slice(2);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-port') this.port = a[++i];
      else if (a[i] === '-pluginUUID') this.uuid = a[++i];
      else if (a[i] === '-registerEvent') this.register = a[++i];
    }
    if (!this.port) { log('No StreamDock port'); process.exit(1); }
    this.ws = new SimpleWS('ws://127.0.0.1:' + this.port, {}, { openTimeoutMs: 10000 });
    this.ws.on('open', () => { this.send({ event: this.register, uuid: this.uuid }); this.emit('connected', {}); });
    this.ws.on('message', s => { let m; try { m = JSON.parse(s); } catch (e) { return log('StreamDock message:', e.message); } this.emit(m.event, m); });
    this.ws.on('error', e => log('StreamDock WS:', e.message));
    // Control Deck owns this process: when it goes away, exit instead of
    // lingering as an orphan node.exe that still talks to Wave Link.
    this.ws.on('close', () => { log('StreamDock connection closed, exiting'); setTimeout(() => process.exit(0), 50); });
    this.ws.connect();
  }
  emit(e, m) { const f = this.handlers[e]; if (f) try { f(m); } catch (x) { log(e, (x && x.stack) || x); } }
  send(o) { if (this.ws && this.ws.opened) { try { this.ws.sendText(JSON.stringify(o)); } catch (e) { log('StreamDock send:', e.message); } } }
  setState(c, state) { this.send({ event: 'setState', context: c, payload: { state: Number(state) } }); }
  setImage(c, i) { this.send({ event: 'setImage', context: c, payload: { image: i, target: 0, state: 0 } }); }
  sendPI(c, payload, action) { this.send({ event: 'sendToPropertyInspector', action, context: c, payload }); }
  setSettings(c, settings) { this.send({ event: 'setSettings', context: c, payload: settings }); }
}

// ------------------------------------------------------------------- Wave Link
const listOf = (r, k) => Array.isArray(r?.[k]) ? r[k] : Array.isArray(r) ? r : Array.isArray(r?.result) ? r.result : [];
const clamp01 = v => Math.max(0, Math.min(1, v));
const round3 = v => Math.round(v * 1000) / 1000;

class WaveLink {
  constructor() {
    this.ws = null; this.next = 1; this.pending = new Map();
    this.channels = []; this.mixes = []; this.inputs = []; this.outputs = [];
    this.connected = false;
    this.retryTimer = null; this.backoff = CFG.reconnectMinMs;
    this.refreshing = null; this.refreshCount = 0;
    this.lastWriteAt = 0; this.writeSeq = 0; this.writeQ = new Map();
    this.notifyTimer = null;
    this.onConnected = () => {};
    this.onChanged = () => {};
    this.onWriteError = () => {};
    this.needDevices = () => false;
  }

  start() { if (!this.ws && !this.retryTimer) this._open(); }

  _schedule() {
    if (this.retryTimer) return;
    const d = this.backoff;
    this.backoff = Math.min(this.backoff * 2, CFG.reconnectMaxMs);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this._open(); }, d);
  }

  _readPort() {
    // Wave Link writes its current port here; it can change between launches,
    // so it is re-read on every connection attempt.
    const p = path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Elgato.WaveLink_g54w8ztgkx496', 'LocalState', 'ws-info.json');
    const port = Number(JSON.parse(fs.readFileSync(p, 'utf8')).port);
    if (!port) throw new Error('invalid port in ws-info.json');
    return port;
  }

  _open() {
    if (this.ws) { const old = this.ws; this.ws = null; old.destroy(); }
    let port;
    try { port = this._readPort(); } catch (e) { log('Wave Link not available:', e.message); return this._schedule(); }
    const ws = new SimpleWS('ws://127.0.0.1:' + port, { Origin: 'streamdeck://' }, { openTimeoutMs: CFG.openTimeoutMs });
    this.ws = ws;
    ws.on('open', async () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.backoff = CFG.reconnectMinMs;
      log('Wave Link connected on port', port);
      try { await this.refresh({ force: true }); } catch (e) { log('Initial refresh:', e.message); }
      this.onConnected();
    });
    ws.on('message', s => { if (this.ws === ws) this._onMessage(s); });
    ws.on('error', e => log('Wave Link WS:', e.message));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.connected;
      this.connected = false;
      this._failPending('Wave Link desconectado');
      for (const q of this.writeQ.values()) clearTimeout(q.timer);
      this.writeQ.clear();
      if (was) log('Wave Link disconnected');
      this._schedule();
    });
    ws.connect();
  }

  _onMessage(s) {
    let m; try { m = JSON.parse(s); } catch { return; }
    if (m.id != null && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || 'Wave Link error')); else p.resolve(m.result);
      return;
    }
    if (m.method && m.id == null) {
      // Change pushed by Wave Link (e.g. moved in its own UI). Debounced, so a
      // constant stream of notifications does not cause a refresh storm.
      clearTimeout(this.notifyTimer);
      this.notifyTimer = setTimeout(() => {
        this.refresh().then(ch => { if (ch) this.onChanged(); }).catch(() => {});
      }, CFG.notifyDebounceMs);
    }
  }

  rpc(method, params = {}, { write = false } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) return reject(new Error('Wave Link desconectado'));
      const id = this.next++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) { if (write) resolve(undefined); else reject(new Error('Wave Link timeout: ' + method)); }
      }, CFG.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.sendText(JSON.stringify({ method, params, id, jsonrpc: '2.0' })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  _failPending(msg) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(msg)); }
    this.pending.clear();
  }

  // Only one refresh at a time; callers share the running one.
  refresh(opts = {}) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._refresh(opts).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async _refresh({ force = false, devices = false } = {}) {
    if (!this.connected) return false;
    const seq = this.writeSeq;
    const wantDevices = force || devices || this.needDevices() || (this.refreshCount++ % CFG.deviceEvery === 0);
    // Channels and mixes are the stable part of the API; devices are optional.
    const [c, m] = await Promise.all([this.rpc('getChannels'), this.rpc('getMixes')]);
    let i = null, o = null;
    if (wantDevices) {
      [i, o] = await Promise.all([
        this.rpc('getInputDevices').catch(e => { log('getInputDevices optional:', e.message); return null; }),
        this.rpc('getOutputDevices').catch(e => { log('getOutputDevices optional:', e.message); return null; }),
      ]);
    }
    // A key was pressed while we were reading (or very recently): this data may
    // be older than the local optimistic state. Drop it; the next poll will catch up.
    if (!force && (seq !== this.writeSeq || Date.now() - this.lastWriteAt < CFG.writeQuietMs)) return false;
    const before = this._snapshot();
    this.channels = listOf(c, 'channels');
    this.mixes = listOf(m, 'mixes');
    if (i !== null) this.inputs = listOf(i, 'inputDevices');
    if (o !== null) this.outputs = listOf(o, 'outputDevices');
    return this._snapshot() !== before;
  }

  _snapshot() { return JSON.stringify([this.channels, this.mixes, this.inputs, this.outputs]); }

  // Writes are fire-and-forget: a key press is sent to Wave Link immediately and
  // never waits for the answer to the previous one (Wave Link may answer writes
  // slowly or not at all). Per target, presses closer than writeMinGapMs are
  // merged into one trailing write carrying the newest value.
  _write(key, method, params) {
    const now = Date.now();
    this.lastWriteAt = now;
    this.writeSeq++;
    let q = this.writeQ.get(key);
    if (!q) { q = { last: 0, timer: null, job: null }; this.writeQ.set(key, q); }
    q.job = { method, params };
    const fire = () => {
      q.timer = null;
      const job = q.job; q.job = null;
      if (!job) return;
      q.last = this.lastWriteAt = Date.now();
      this.rpc(job.method, job.params, { write: true }).catch(e => this.onWriteError(e));
    };
    if (q.timer) return;
    const wait = CFG.writeMinGapMs - (now - q.last);
    if (wait <= 0) fire(); else q.timer = setTimeout(fire, wait);
  }

  channel(id) { return this.channels.find(x => x.id === id); }
  mix(id) { return this.mixes.find(x => x.id === id); }
  inputTarget(id) { for (const d of this.inputs) { const x = (d.inputs || []).find(v => v.id === id); if (x) return { device: d, input: x }; } return null; }
  outputTarget(id) { for (const d of this.outputs) { const x = (d.outputs || []).find(v => v.id === id); if (x) return { device: d, output: x }; } return null; }

  getValue(t) {
    if (!t) return { muted: false, level: 0 };
    if (t.type === 'channel') { const c = this.channel(t.id); return { muted: !!c?.isMuted, level: Number(c?.level ?? 0), name: c?.name }; }
    if (t.type === 'channelSend') { const c = this.channel(t.id); const m = (c?.mixes || []).find(x => x.id === t.mix); return { muted: !!m?.isMuted, level: Number(m?.level ?? 0), name: c?.name }; }
    if (t.type === 'mix') { const m = this.mix(t.id); return { muted: !!m?.isMuted, level: Number(m?.level ?? 0), name: m?.name }; }
    if (t.type === 'output') { const x = this.outputTarget(t.id); return { muted: !!x?.output?.isMuted, level: Number(x?.output?.level ?? 0), name: x?.output?.name || x?.device?.name }; }
    return { muted: false, level: 0 };
  }

  // Resolves the object that holds isMuted/level locally plus how to write it.
  _resolve(t) {
    if (t.type === 'channel') {
      const c = this.channel(t.id); if (!c) throw new Error('Canal não encontrado');
      return { obj: c, send: p => ['setChannel', { id: t.id, ...p }] };
    }
    if (t.type === 'channelSend') {
      const c = this.channel(t.id); const m = c?.mixes?.find(x => x.id === t.mix);
      if (!m) throw new Error('Mix não encontrado para o canal');
      return { obj: m, send: p => ['setChannel', { id: t.id, mixes: [{ id: t.mix, ...p }] }] };
    }
    if (t.type === 'mix') {
      const m = this.mix(t.id); if (!m) throw new Error('Mix não encontrado');
      return { obj: m, send: p => ['setMix', { id: t.id, ...p }] };
    }
    if (t.type === 'output') {
      const x = this.outputTarget(t.id); if (!x) throw new Error('Saída não encontrada');
      return { obj: x.output, send: p => ['setOutputDevice', { outputDevice: { id: x.device.id, outputs: [{ id: x.output.id, ...p }] } }] };
    }
    throw new Error('Tipo de alvo não suportado: ' + t.type);
  }

  _key(t, what) { return [t.type, t.id, t.mix || '', what].join('|'); }

  // Both return synchronously after updating local state; the write runs in the background.
  mutate(t) {
    const r = this._resolve(t);
    const value = !r.obj.isMuted;
    r.obj.isMuted = value;
    const [method, params] = r.send({ isMuted: value });
    this._write(this._key(t, 'mute'), method, params);
    return { atLimit: false };
  }

  change(t, delta) {
    const r = this._resolve(t);
    const level = round3(clamp01(Number(r.obj.level ?? 0) + delta));
    r.obj.level = level;
    const atLimit = (delta < 0 && level <= 0) || (delta > 0 && level >= 1);
    const [method, params] = r.send({ level });
    this._write(this._key(t, 'level'), method, params);
    return { atLimit };
  }

  catalog() {
    const flattenInputs = this.inputs.flatMap(d => Array.isArray(d?.inputs)
      ? d.inputs.map(x => ({ id: x.id, name: ((d.name || 'Entrada') + ' — ' + (x.name || 'Entrada')).trim(), isMuted: x.isMuted, gain: x.gain }))
      : (d?.id ? [{ id: d.id, name: d.name || 'Entrada', isMuted: d.isMuted, gain: d.gain }] : []));
    const flattenOutputs = this.outputs.flatMap(d => Array.isArray(d?.outputs)
      ? d.outputs.map(x => ({ id: x.id, name: ((d.name || 'Saída') + ' — ' + (x.name || 'Saída')).trim(), isMuted: x.isMuted, level: x.level }))
      : (d?.id ? [{ id: d.id, name: d.name || 'Saída', isMuted: d.isMuted, level: d.level }] : []));
    return {
      connected: this.connected,
      channels: this.channels.map(x => ({ id: x.id, name: x.name, level: x.level, isMuted: x.isMuted })),
      mixes: this.mixes.map(x => ({ id: x.id, name: x.name, level: x.level, isMuted: x.isMuted })),
      inputs: flattenInputs,
      outputs: flattenOutputs,
    };
  }
}

// --------------------------------------------------------------------- Images
const imgDir = path.join(__dirname, '..', 'imgs');
const fileCache = new Map();
function img(name) {
  let v = fileCache.get(name);
  if (!v) {
    let p = path.join(imgDir, name + '.png'), mime = 'image/png';
    if (!fs.existsSync(p)) { p = path.join(imgDir, name + '.svg'); mime = 'image/svg+xml'; }
    v = 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
    fileCache.set(name, v);
  }
  return v;
}

const renderCache = new Map(); // finished images, keyed by what they show
function imageFor(a, s) {
  const pctValue = Math.max(0, Math.min(100, Math.round((s.level || 0) * 100)));
  const key = a.kind === 'volume' ? 'v|' + a.icon
    : a.kind === 'mute' ? `m|${s.muted ? 1 : 0}|${pctValue}`
    : `s|${a.statusIcon}|${s.muted ? 1 : 0}|${pctValue}`;
  let out = renderCache.get(key);
  if (out) return out;
  if (a.kind === 'mute') out = img((s.muted ? 'mic-muted' : 'mic-live') + '-' + pctValue);
  else if (a.kind === 'status') out = img(a.statusIcon + (s.muted ? '-muted' : '-active'));
  else out = img(a.icon);
  if (a.kind === 'status' && out.startsWith('data:image/svg+xml;base64,')) {
    const b = Buffer.from(out.split(',')[1], 'base64').toString('utf8');
    const svg = b.replace(/<text x="72" y="119"[^>]*>.*?<\/text>/s, '');
    const color = s.muted ? '#ff4d5f' : (a.statusIcon === 'input' ? '#42d9ff' : a.statusIcon === 'output' ? '#8b7cff' : '#ffb347');
    const label = `<text x="72" y="24" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="18" font-weight="700" fill="${color}">${pctValue}%</text>`;
    out = 'data:image/svg+xml;base64,' + Buffer.from(svg.replace('</svg>', label + '</svg>')).toString('base64');
  }
  renderCache.set(key, out);
  return out;
}

// -------------------------------------------------------------------- Plugin
const sd = new StreamDock(), wl = new WaveLink();
const owners = new Map();   // context -> action state
const timers = new Map();   // context -> hold-repeat timers
const lastSent = new Map(); // context -> { state, image } last pushed to Control Deck

// Older builds stored the whole Wave Link catalog inside every key's settings.
function cleanSettings(s) { const o = Object.assign({}, s || {}); delete o._catalog; return o; }
function settingTarget(a) { const s = a.settings || {}; if (!s.targetType || !s.targetId) return null; return { type: s.targetType, id: s.targetId, mix: s.mixId }; }
const hasState = a => a.kind === 'status' || a.kind === 'mute';
// Default ON: never replace the image the user picked in Control Deck.
// Mute/status keys still switch between state 0 (live) and state 1 (muted),
// so a custom image per state keeps working.
const keepImage = a => (a.settings || {}).keepImage !== false;

function render(ctx, a) {
  try {
    const s = wl.getValue(settingTarget(a));
    const prev = lastSent.get(ctx) || {};
    const next = { state: prev.state, image: prev.image };
    if (hasState(a)) {
      const st = s.muted ? 1 : 0;
      if (prev.state !== st) { sd.setState(ctx, st); next.state = st; }
    }
    if (keepImage(a)) {
      // We had drawn on this key before (option was just switched on):
      // an empty setImage hands the key back to the user's / default image.
      if (prev.image) sd.send({ event: 'setImage', context: ctx, payload: { target: 0 } });
      next.image = null;
    } else {
      const image = imageFor(a, s);
      if (prev.image !== image) { sd.setImage(ctx, image); next.image = image; }
    }
    lastSent.set(ctx, next);
  } catch (e) { log('Render:', e.message); }
}
function renderAll() { for (const [ctx, a] of owners) render(ctx, a); }

let resyncTimer = null;
function scheduleResync() {
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    wl.refresh({ force: true }).then(() => renderAll()).catch(() => {});
  }, 300);
}

function act(ctx, a) {
  const t = settingTarget(a);
  if (!t) { log('Ação não configurada'); return null; }
  if (!wl.connected) return null;
  let r;
  try { r = a.kind === 'volume' ? wl.change(t, a.delta) : wl.mutate(t); }
  catch (e) { log('Wave Link action:', e.message); scheduleResync(); return null; }
  renderAll(); // other keys may show the same target
  return r;
}

function startRepeat(ctx, a) {
  stopRepeat(ctx);
  const first = act(ctx, a);
  if (a.kind !== 'volume' || !first || first.atLimit) return;
  const started = Date.now();
  const t = { delay: null, iv: null };
  t.delay = setTimeout(() => {
    t.delay = null;
    t.iv = setInterval(() => {
      if (Date.now() - started > CFG.repeatMaxMs) return stopRepeat(ctx);
      const r = act(ctx, owners.get(ctx) || a);
      if (!r || r.atLimit) stopRepeat(ctx);
    }, CFG.repeatEveryMs);
  }, CFG.repeatDelayMs);
  timers.set(ctx, t);
}
function stopRepeat(ctx) {
  const t = timers.get(ctx); if (!t) return;
  if (t.delay) clearTimeout(t.delay);
  if (t.iv) clearInterval(t.iv);
  timers.delete(ctx);
}

// Control Deck does not reliably relay messages between the settings panel and
// the plugin, so (like v1.0.0) the target list is stored in each key's settings,
// where the panel reads it when it opens. Only ids + names are stored, and only
// when that list actually changes - volume changes never cause a settings write.
function slimCatalog() {
  const c = wl.catalog(), pick = arr => (arr || []).map(x => ({ id: x.id, name: x.name }));
  return { connected: wl.connected, channels: pick(c.channels), mixes: pick(c.mixes), inputs: pick(c.inputs), outputs: pick(c.outputs) };
}
function storeCatalog(ctx, force) {
  const a = owners.get(ctx); if (!a || !wl.connected) return;
  const cat = slimCatalog(), k = JSON.stringify(cat);
  if (!force && a.storedCatalog === k) return;
  a.storedCatalog = k;
  sd.setSettings(ctx, Object.assign({}, cleanSettings(a.settings), { _catalog: cat }));
}
function storeCatalogAll() { for (const ctx of owners.keys()) storeCatalog(ctx); }
function sendCatalog(ctx) {
  const a = owners.get(ctx); if (!a) return;
  if (wl.connected) storeCatalog(ctx, true);
  const cat = slimCatalog();
  sd.sendPI(ctx, { type: 'catalog', catalog: cat, settings: cleanSettings(a.settings) }, a.action);
  log('Catalog sent:', cat.channels.length + ' channels,', cat.mixes.length + ' mixes, connected=' + cat.connected);
}

wl.needDevices = () => { for (const a of owners.values()) { const ty = a.settings?.targetType; if (ty === 'output' || ty === 'input') return true; } return false; };
wl.onChanged = () => { renderAll(); storeCatalogAll(); };
wl.onWriteError = e => { log('Wave Link write:', e.message); scheduleResync(); };
wl.onConnected = () => { renderAll(); storeCatalogAll(); };

sd.on('willAppear', m => {
  const def = ACTIONS[m.action]; if (!def) return;
  const raw = m.payload?.settings || {};
  const initial = cleanSettings(raw);
  if (def.defaultType && !initial.targetType) initial.targetType = def.defaultType;
  const a = Object.assign({}, def, { action: m.action, settings: initial });
  if (raw._catalog) a.storedCatalog = JSON.stringify(raw._catalog);
  owners.set(m.context, a);
  lastSent.delete(m.context); // the key is (re)drawn: push its image again
  render(m.context, a);
  storeCatalog(m.context);
});
sd.on('willDisappear', m => { stopRepeat(m.context); owners.delete(m.context); lastSent.delete(m.context); });
sd.on('keyDown', m => {
  const a = owners.get(m.context); if (!a) return;
  if (m.payload?.settings) a.settings = Object.assign({}, a.settings, cleanSettings(m.payload.settings));
  if (hasState(a)) act(m.context, a); else startRepeat(m.context, a);
});
sd.on('keyUp', m => stopRepeat(m.context));
sd.on('didReceiveSettings', m => {
  const a = owners.get(m.context); if (!a) return;
  a.settings = Object.assign({}, a.settings, cleanSettings(m.payload?.settings));
  render(m.context, a);
});
sd.on('sendToPlugin', m => {
  const p = m.payload || {};
  if (p.request === 'catalog') {
    if (!wl.connected) { log('Catalog requested but Wave Link is not connected'); return sendCatalog(m.context); }
    wl.refresh({ devices: true }).catch(e => log('Catalog:', e.message)).finally(() => { sendCatalog(m.context); renderAll(); });
  }
});
sd.on('connected', () => { log('Plugin started, connected to Control Deck'); wl.start(); });

setInterval(() => {
  if (!wl.connected) return;
  wl.refresh().then(changed => { if (changed) { renderAll(); storeCatalogAll(); } }).catch(e => log('Wave Link refresh:', e.message));
}, CFG.pollMs);

sd.connect();
