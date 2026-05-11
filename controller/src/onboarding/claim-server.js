/* HTTP listener for `POST /discovery/claim`.

   Implements the spec at docs/app/onboarding.md §2: accepts broker
   credentials from the Headwaters host-side mDNS proxy, persists them via
   the existing SettingsStore, and triggers `mqtt.reconfigure()`. Returns
   200 synchronously without waiting for the broker to actually connect —
   the wizard observes broker presence via its retained system/status
   topic for liveness confirmation.

   No Express. No middleware. One route. Plain Node `http` so it ships
   without dragging in another dep tree.

   Security stance (from the spec):
     - Plain HTTP on the LAN is acceptable for v1. Same trust boundary as
       the existing CAN-broadcast WiFi creds.
     - The body contains the MQTT password in cleartext — never log it.
     - Reject (`409 Conflict`) when already configured unless `X-Reclaim:
       true` is set, so a hostile device on the LAN can't overwrite an
       already-onboarded Playbill.
     - Bind on port 80, which requires CAP_NET_BIND_SERVICE on the node
       binary (`sudo setcap 'cap_net_bind_service=+ep' /usr/bin/node`).
       The image build step / firstboot hook should set this. */

'use strict';

const http = require('http');
const fs   = require('fs');

const { CA_CERT_FILE } = require('../paths');
const { SERVICE_PORT } = require('./mdns');

const MAX_BODY_BYTES = 16 * 1024;   // creds + cert fits comfortably; reject anything wild

class ClaimServer {
  /**
   * @param {object} opts
   * @param {object} opts.connection            SettingsStore for connection.json
   * @param {object} opts.mqtt                   MqttBridge with .reconfigure()
   * @param {() => boolean} opts.isClaimed       returns true iff connection.json already exists
   * @param {() => void} [opts.onClaimed]        called after a successful claim, before 200 returns
   * @param {object} [opts.stateStore]           optional — patched with claim status if provided
   */
  constructor({ connection, mqtt, isClaimed, onClaimed, stateStore }) {
    if (!connection || !mqtt || typeof isClaimed !== 'function') {
      throw new Error('ClaimServer: connection + mqtt + isClaimed required');
    }
    this._connection = connection;
    this._mqtt = mqtt;
    this._isClaimed = isClaimed;
    this._onClaimed = onClaimed || (() => {});
    this._state = stateStore || null;
    this._server = null;
  }

  start() {
    if (this._server) return;
    this._server = http.createServer((req, res) => this._handle(req, res));
    this._server.on('error', (err) => {
      if (err.code === 'EACCES') {
        console.error('[claim-server] cannot bind port ' + SERVICE_PORT +
          ' — needs CAP_NET_BIND_SERVICE on the node binary. Onboarding disabled.');
      } else {
        console.error('[claim-server] error:', err.message);
      }
    });
    this._server.listen(SERVICE_PORT, () => {
      console.log('[claim-server] listening on :' + SERVICE_PORT + '/discovery/claim');
    });
  }

  async stop() {
    if (this._server) {
      await new Promise((r) => this._server.close(() => r()));
      this._server = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────

  _handle(req, res) {
    if (req.method !== 'POST' || req.url !== '/discovery/claim') {
      return reply(res, 404, { error: 'Not found' });
    }

    let len = 0;
    const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY_BYTES) {
        req.destroy();
        return reply(res, 413, { error: 'Body too large' });
      }
      chunks.push(c);
    });
    req.on('end', () => this._onBody(req, res, Buffer.concat(chunks)));
    req.on('error', (e) => reply(res, 400, { error: 'Request error: ' + e.message }));
  }

  async _onBody(req, res, body) {
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8') || '{}');
    } catch (e) {
      return reply(res, 400, { error: 'Invalid JSON: ' + e.message });
    }

    const { brokerUrl, username, password, caCertPem, tlsCertHostname } = payload;

    // 1. Validate.
    if (typeof brokerUrl !== 'string' || !brokerUrl.startsWith('mqtt')) {
      return reply(res, 400, { error: 'brokerUrl required, must be mqtt:// or mqtts://' });
    }
    if (typeof username !== 'string' || !username.length) {
      return reply(res, 400, { error: 'username required' });
    }
    if (typeof password !== 'string' || !password.length) {
      return reply(res, 400, { error: 'password required' });
    }
    if (caCertPem !== undefined && typeof caCertPem !== 'string') {
      return reply(res, 400, { error: 'caCertPem must be a string when present' });
    }
    if (caCertPem && !caCertPem.includes('-----BEGIN CERTIFICATE-----')) {
      return reply(res, 400, { error: 'caCertPem does not look PEM-encoded' });
    }

    // 2. Reclaim guard.
    if (this._isClaimed() && req.headers['x-reclaim'] !== 'true') {
      return reply(res, 409, {
        error: 'Already configured. Send X-Reclaim: true to overwrite.',
      });
    }

    // 3. Persist atomically — CA cert first so caCertProvided is true on save.
    try {
      if (caCertPem) {
        fs.writeFileSync(CA_CERT_FILE, caCertPem, { mode: 0o600 });
      }
      await this._connection.replace({
        brokerUrl, username, password,
        tlsCertHostname: tlsCertHostname || null,
        caCertProvided: !!caCertPem,
      });
    } catch (e) {
      // Don't echo creds even on error — only the message + the kind of failure.
      console.error('[claim-server] persist failed:', e.message);
      return reply(res, 500, { error: 'Persist failed: ' + e.message });
    }

    // 4. Reconnect MQTT in the background. Don't block the 200.
    console.log(`[claim] persisted; calling mqtt.reconfigure for brokerUrl=${brokerUrl}` +
                (tlsCertHostname ? ` (tlsCertHostname=${tlsCertHostname})` : '') +
                (caCertPem ? ' (caCert provided)' : ''));
    this._mqtt.reconfigure().catch((e) => {
      console.error('[claim-server] mqtt.reconfigure failed:', e.message);
    });

    // 5. State update + onClaimed (which stops the mDNS advert).
    if (this._state) {
      const cur = this._state.get();
      this._state.patch({
        connection: {
          status: 'configured',
          brokerUrl,
          lastError: null,
        },
      });
    }
    try { this._onClaimed(); } catch (e) { console.error('[claim-server] onClaimed:', e.message); }

    return reply(res, 200, { ok: true });
  }
}

function reply(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

module.exports = ClaimServer;
