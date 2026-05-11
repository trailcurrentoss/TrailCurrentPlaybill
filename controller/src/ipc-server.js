/* IPC server — Unix domain socket for the local Electron GUI.

   Wire format: newline-delimited JSON, one message per line.

   Two message types only:
     • { kind: "command", id: <string>, cmd: { action, ... } }
         → server replies on same id with { kind: "ack", id, ok: true|false, result?, error? }
     • { kind: "subscribe", topic: "state" }
         → server immediately replies once with { kind: "snapshot", topic: "state", state: {...} }
         → then pushes { kind: "delta", topic: "state", patch: {...}, state: {...} } on every change

   No "unsubscribe" — clients close the socket. No multiplexing — one client
   per socket. (We allow multiple concurrent clients on the same socket file;
   each gets its own snapshot stream.)

   The socket lives at $XDG_RUNTIME_DIR/playbill-controller.sock. File mode
   0600 so other users on the box can't drive the daemon. The file is
   removed at SIGINT/SIGTERM and on graceful shutdown. */

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { IPC_SOCKET, RUNTIME_DIR } = require('./paths');

class IpcServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./command-bus')} opts.commandBus
   * @param {import('./state-store')} opts.stateStore
   */
  constructor({ commandBus, stateStore }) {
    super();
    if (!commandBus) throw new Error('IpcServer: commandBus required');
    if (!stateStore) throw new Error('IpcServer: stateStore required');
    this._bus = commandBus;
    this._state = stateStore;
    this._server = null;
    this._clients = new Set();
    this._unsubFromState = null;
  }

  /** True iff at least one IPC client (i.e., a Playbill GUI) is connected. */
  hasClients() { return this._clients.size > 0; }

  async start() {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
    // Stale socket from a prior run (crash, kill -9, ...) — remove it before
    // bind, otherwise net.createServer throws EADDRINUSE.
    try { fs.unlinkSync(IPC_SOCKET); } catch (e) { if (e.code !== 'ENOENT') throw e; }

    this._server = net.createServer((socket) => this._onConnection(socket));
    await new Promise((resolve, reject) => {
      this._server.once('error', reject);
      this._server.listen(IPC_SOCKET, () => {
        // Belt-and-suspenders: net.createServer may not honor mode on every
        // platform. Force 0600 after bind.
        try { fs.chmodSync(IPC_SOCKET, 0o600); } catch (_) { /* best-effort */ }
        resolve();
      });
    });

    this._unsubFromState = this._state.subscribe((evt) => this._fanOutDelta(evt));
    return IPC_SOCKET;
  }

  async stop() {
    if (this._unsubFromState) { this._unsubFromState(); this._unsubFromState = null; }
    for (const c of this._clients) { try { c.socket.destroy(); } catch (_) {} }
    this._clients.clear();
    if (this._server) {
      await new Promise((r) => this._server.close(() => r()));
      this._server = null;
    }
    try { fs.unlinkSync(IPC_SOCKET); } catch (_) {}
  }

  _onConnection(socket) {
    const client = { socket, subs: new Set(), buf: '' };
    const wasEmpty = this._clients.size === 0;
    this._clients.add(client);
    if (wasEmpty) this.emit('first-client');

    socket.on('data', (chunk) => {
      client.buf += chunk.toString('utf8');
      let nl;
      // Process every complete line; leave any trailing partial in the buf.
      while ((nl = client.buf.indexOf('\n')) >= 0) {
        const line = client.buf.slice(0, nl);
        client.buf = client.buf.slice(nl + 1);
        if (line.trim()) this._handleLine(client, line).catch((e) => {
          // Synchronous protocol errors are surfaced once on the wire and
          // logged — never let an unhandled rejection crash the daemon.
          console.error('[ipc] line handler threw:', e);
          this._send(client, { kind: 'error', error: String(e && e.message || e) });
        });
      }
    });

    socket.on('close', () => {
      this._clients.delete(client);
      if (this._clients.size === 0) this.emit('last-client-gone');
    });
    socket.on('error', (e) => {
      // ECONNRESET on client crash; not actionable, just log at debug.
      if (e.code !== 'ECONNRESET') console.error('[ipc] socket error:', e);
    });
  }

  async _handleLine(client, line) {
    let msg;
    try { msg = JSON.parse(line); }
    catch (e) {
      this._send(client, { kind: 'error', error: 'invalid json: ' + e.message });
      return;
    }

    if (msg.kind === 'command') {
      const id = msg.id;
      try {
        const result = await this._bus.dispatch(msg.cmd, { from: 'ipc' });
        this._send(client, { kind: 'ack', id, ok: true, result });
      } catch (e) {
        this._send(client, { kind: 'ack', id, ok: false, error: String(e && e.message || e) });
      }
      return;
    }

    if (msg.kind === 'subscribe' && msg.topic === 'state') {
      client.subs.add('state');
      this._send(client, { kind: 'snapshot', topic: 'state', state: this._state.get() });
      return;
    }

    this._send(client, { kind: 'error', error: 'unknown message kind: ' + msg.kind });
  }

  _fanOutDelta(evt) {
    const wire = { kind: 'delta', topic: 'state', patch: evt.patch, state: evt.state };
    for (const c of this._clients) {
      if (c.subs.has('state')) this._send(c, wire);
    }
  }

  _send(client, obj) {
    try {
      client.socket.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      // Socket already gone; will be cleaned up by 'close'.
    }
  }
}

module.exports = IpcServer;
