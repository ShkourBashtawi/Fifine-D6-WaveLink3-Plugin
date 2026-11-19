'use strict';
// Minimal WebSocket client (RFC 6455) on top of net.
// Stability changes vs. v1.0.0:
//  - TCP_NODELAY on: small control messages are sent immediately (no Nagle delay).
//  - TCP keep-alive, handshake timeout.
//  - Fragmented messages (continuation frames) are reassembled.
//  - Protocol errors close the connection instead of crashing the process.
//  - 'close' is emitted exactly once.
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');
const EventEmitter = require('events');

const MAX_MESSAGE = 16 * 1024 * 1024;

class SimpleWS extends EventEmitter {
  constructor(url, defaultHeaders = {}, opts = {}) {
    super();
    this.url = new URL(url);
    this.defaultHeaders = defaultHeaders;
    this.openTimeoutMs = opts.openTimeoutMs || 0;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.opened = false;
    this.closed = false;
    this.frag = null;
    this.fragOp = 0;
    this.fragLen = 0;
    this.openTimer = null;
  }

  connect(extraHeaders = {}) {
    const port = Number(this.url.port || 80), host = this.url.hostname;
    const s = net.createConnection({ host, port });
    this.socket = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 10000);
    if (this.openTimeoutMs) {
      this.openTimer = setTimeout(() => {
        if (!this.opened) this._fail(new Error('WebSocket open timeout'));
      }, this.openTimeoutMs);
    }
    s.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      let req = `GET ${this.url.pathname || '/'} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
      const headers = { ...this.defaultHeaders, ...extraHeaders };
      for (const [k, v] of Object.entries(headers)) req += `${k}: ${v}\r\n`;
      req += '\r\n';
      s.write(req);
    });
    s.on('data', d => { try { this._data(d); } catch (e) { this._fail(e); } });
    s.on('error', e => this.emit('error', e)); // 'close' always follows
    s.on('close', () => this._closed());
  }

  _emitSafe(ev, arg) {
    try { this.emit(ev, arg); } catch (e) { try { console.error('ws listener:', e && e.message); } catch {} }
  }

  _fail(e) {
    this._emitSafe('error', e);
    this.destroy();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    clearTimeout(this.openTimer);
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this._emitSafe('close');
  }

  destroy() {
    clearTimeout(this.openTimer);
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this._closed();
  }

  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (!this.opened) {
      const i = this.buf.indexOf('\r\n\r\n');
      if (i < 0) {
        if (this.buf.length > 65536) throw new Error('WebSocket handshake too large');
        return;
      }
      const h = this.buf.subarray(0, i).toString();
      if (!/^HTTP\/1\.1 101/.test(h)) throw new Error('WebSocket handshake failed: ' + h.split('\r\n')[0]);
      this.opened = true;
      clearTimeout(this.openTimer);
      this.buf = this.buf.subarray(i + 4);
      this._emitSafe('open');
    }
    while (this.buf.length >= 2 && !this.closed) {
      const b1 = this.buf[0], b2 = this.buf[1];
      let len = b2 & 127, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) > 0) throw new Error('Frame too large');
        len = this.buf.readUInt32BE(6); off = 10;
      }
      if (len > MAX_MESSAGE) throw new Error('Frame too large');
      const masked = (b2 & 128) !== 0;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) {
        const mk = this.buf.subarray(off - 4, off);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i % 4];
      }
      this.buf = this.buf.subarray(off + len);
      const fin = (b1 & 0x80) !== 0, op = b1 & 15;

      if (op === 0x8) { // close
        try { this._sendFrame(Buffer.alloc(0), 8); } catch {}
        if (this.socket) this.socket.end();
        return;
      }
      if (op === 0x9) { this._sendFrame(payload, 0xA); continue; } // ping -> pong
      if (op === 0xA) continue; // pong
      if (op === 0x1 || op === 0x2) {
        if (fin) { if (op === 0x1) this._emitSafe('message', payload.toString('utf8')); }
        else { this.frag = [payload]; this.fragOp = op; this.fragLen = len; }
        continue;
      }
      if (op === 0x0) { // continuation
        if (!this.frag) continue;
        this.frag.push(payload);
        this.fragLen += len;
        if (this.fragLen > MAX_MESSAGE) throw new Error('Message too large');
        if (fin) {
          const all = Buffer.concat(this.frag);
          this.frag = null;
          if (this.fragOp === 0x1) this._emitSafe('message', all.toString('utf8'));
        }
      }
    }
  }

  _sendFrame(payload, opcode = 1) {
    const s = this.socket;
    if (!s || s.destroyed || !s.writable) return false;
    payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const len = payload.length, mk = crypto.randomBytes(4);
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[0] = 0x80 | opcode; head[1] = 0x80 | len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    const out = Buffer.from(payload);
    for (let i = 0; i < out.length; i++) out[i] ^= mk[i % 4];
    s.write(Buffer.concat([head, mk, out]));
    return true;
  }

  sendText(s) {
    if (!this.opened) throw new Error('WebSocket not open');
    if (!this._sendFrame(Buffer.from(s), 1)) throw new Error('WebSocket not writable');
  }

  close() {
    try { this._sendFrame(Buffer.alloc(0), 8); if (this.socket) this.socket.end(); } catch {}
    setTimeout(() => this.destroy(), 1000).unref?.();
  }
}

module.exports = { SimpleWS };
