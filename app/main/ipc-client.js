/* Controller IPC client — Electron main process side.

   Connects to the playbill-controller daemon over its Unix domain socket,
   subscribes to state, and exposes a thin command/state API the renderer
   can call via preload. Auto-reconnects if the daemon isn't running yet
   or restarts under us; the GUI sees disconnect events and can render an
   appropriate "controller offline" state.

   Wire format matches IpcServer in controller/src/ipc-server.js. */

'use strict';

const net    = require('net');
const path   = require('path');
const fs     = require('fs');
const { EventEmitter } = require('events');

const SOCKET_PATH = (() => {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return path.join(xdg, 'playbill-controller.sock');
  // Fallback for non-systemd setups; matches controller paths.js
  const uid = (typeof process.getuid === 'function') ? process.getuid() : 0;
  return path.join('/tmp', 'runtime-' + uid, 'playbill-controller.sock');
})();

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS     = 5000;
const COMMAND_TIMEOUT_MS   = 10000;

class ControllerClient extends EventEmitter {
  constructor() {
    super();
    this._socket  = null;
    this._buf     = '';
    this._pending = new Map();          // id → { resolve, reject, timer }
    this._nextId  = 1;
    this._state   = null;
    this._connected = false;
    this._reconnectDelay = RECONNECT_INITIAL_MS;
    this._stopped = false;
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._socket) { try { this._socket.destroy(); } catch (_) {} }
    this._socket = null;
    this._connected = false;
    for (const p of this._pending.values()) {
      try { clearTimeout(p.timer); } catch (_) {}
      p.reject(new Error('controller client stopped'));
    }
    this._pending.clear();
  }

  isConnected() { return this._connected; }
  getState()    { return this._state; }

  /** Fire a command. Returns the handler's result. Rejects on error/timeout. */
  command(cmd) {
    if (!this._socket || !this._connected) {
      return Promise.reject(new Error('controller not connected'));
    }
    return new Promise((resolve, reject) => {
      const id = String(this._nextId++);
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`controller command timed out: ${cmd && cmd.action}`));
      }, COMMAND_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._socket.write(JSON.stringify({ kind: 'command', id, cmd }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────

  _connect() {
    if (this._stopped) return;
    if (!fs.existsSync(SOCKET_PATH)) {
      // Daemon not running yet — try again shortly.
      this._scheduleReconnect();
      return;
    }
    const sock = net.createConnection(SOCKET_PATH);
    sock.once('connect', () => {
      this._socket = sock;
      this._connected = true;
      this._reconnectDelay = RECONNECT_INITIAL_MS;
      this.emit('connected');
      // Always subscribe immediately — we want the snapshot.
      try { sock.write('{"kind":"subscribe","topic":"state"}\n'); } catch (_) {}
    });
    sock.on('data', (chunk) => this._onData(chunk));
    sock.on('error', (e) => {
      // ENOENT/ECONNREFUSED means daemon is not up; common during boot.
      // Anything else logs once.
      if (e.code !== 'ENOENT' && e.code !== 'ECONNREFUSED') {
        console.error('[ipc-client] socket error:', e.message);
      }
    });
    sock.on('close', () => {
      this._socket = null;
      this._connected = false;
      this._buf = '';
      this.emit('disconnected');
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    setTimeout(() => this._connect(), this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) {
        console.error('[ipc-client] non-JSON from controller:', e.message);
        continue;
      }
      this._handle(msg);
    }
  }

  _handle(msg) {
    if (msg.kind === 'snapshot' && msg.topic === 'state') {
      this._state = msg.state;
      this.emit('state', this._state);
      return;
    }
    if (msg.kind === 'delta' && msg.topic === 'state') {
      this._state = msg.state;
      this.emit('state', this._state);
      return;
    }
    if (msg.kind === 'ack') {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      try { clearTimeout(p.timer); } catch (_) {}
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'controller returned error'));
      return;
    }
    if (msg.kind === 'error') {
      console.error('[ipc-client] server error:', msg.error);
    }
  }
}

module.exports = ControllerClient;
module.exports.SOCKET_PATH = SOCKET_PATH;
