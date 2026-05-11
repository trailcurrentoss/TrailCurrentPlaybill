/* MQTT bridge — connects to the rig broker, fans inbound commands into
   the command bus, fans outbound state changes onto retained topics.

   Topic layout (matches docs/app/architecture.md §4):

     local/playbill/<deviceId>/<feature>/command   ← we subscribe + dispatch
     local/playbill/<deviceId>/<feature>/status    → we publish (retained)
     local/playbill/all/<feature>/command          ← broadcast — also dispatched
     local/playbill/<deviceId>/system/status       → presence (retained + LWT)

   Reconnect behavior:
     • mqtt.connect already retries on its own (reconnectPeriod option).
     • On `connection.set` from the GUI, reconfigure() tears down the
       current client and brings up a new one with the new credentials.
     • State.connection.status reflects: unconfigured | configured |
       connecting | connected | error.

   Security:
     • TLS only when brokerUrl uses mqtts://. CA cert read from disk if
       caCertProvided=true. checkServerIdentity overridden when
       tlsCertHostname is set (matches Headwaters pattern at mqtt.js:97).
     • The MQTT password is read from ~/.config/.../connection.json and
       passed to mqtt.connect; never logged, never published. */

'use strict';

const fs   = require('fs');
const tls  = require('tls');
const mqtt = require('mqtt');

const { CA_CERT_FILE } = require('./paths');

const TOPIC_ROOT = 'local';
const SUBSYSTEM  = 'playbill';
const BROADCAST  = 'all';

const DEFAULT_MQTT_PORT = 8883;

/**
 * Canonicalize whatever the user / PWA hands us as a broker address into
 * the strict form `mqtts://host:port` (no path/query/fragment, never
 * insecure). The Settings UI accepts a bare hostname; PWAs may send a
 * full URL. Both flow through here before persistence so connection.json
 * always contains the canonical form.
 *
 *   ''                              → throws
 *   'broker.local'                  → 'mqtts://broker.local:8883'
 *   'broker.local:9001'             → 'mqtts://broker.local:9001'
 *   'mqtt://broker.local'           → 'mqtts://broker.local:8883'    (upgraded)
 *   'mqtts://broker.local'          → 'mqtts://broker.local:8883'
 *   'mqtts://broker.local:8883/foo' → 'mqtts://broker.local:8883'    (path stripped)
 *   'http://...'                    → throws (wrong scheme)
 */
function normalizeBrokerUrl(input) {
  if (typeof input !== 'string') throw new Error('brokerUrl must be a string');
  let s = input.trim();
  if (!s) throw new Error('brokerUrl required');
  // No scheme → treat as bare hostname[:port].
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'mqtts://' + s;

  let url;
  try { url = new URL(s); }
  catch (e) { throw new Error('brokerUrl invalid: ' + e.message); }

  if (url.protocol === 'mqtt:') url.protocol = 'mqtts:';   // upgrade insecure
  if (url.protocol !== 'mqtts:') {
    throw new Error('brokerUrl scheme must be mqtts:// (got ' + url.protocol + '//)');
  }
  if (!url.hostname) throw new Error('brokerUrl missing hostname');
  if (!url.port) url.port = String(DEFAULT_MQTT_PORT);

  return 'mqtts://' + url.host;     // host == hostname[:port]; no path/query/fragment
}

function topicCommandSub(deviceId)  { return `${TOPIC_ROOT}/${SUBSYSTEM}/${deviceId}/+/command`; }
function topicCommandBroadcast()    { return `${TOPIC_ROOT}/${SUBSYSTEM}/${BROADCAST}/+/command`; }
function topicStatus(deviceId, feat){ return `${TOPIC_ROOT}/${SUBSYSTEM}/${deviceId}/${feat}/status`; }
function topicPresence(deviceId)    { return `${TOPIC_ROOT}/${SUBSYSTEM}/${deviceId}/system/status`; }

class MqttBridge {
  /**
   * @param {object} opts
   * @param {import('./command-bus')} opts.commandBus
   * @param {import('./state-store')} opts.stateStore
   * @param {() => object|null} opts.getConnection   read connection.json (without password masking — we need the password)
   * @param {() => string} opts.getDeviceId
   * @param {() => string} opts.getDeviceName
   * @param {() => string} opts.getVersion
   */
  constructor(opts) {
    this._opts = opts;
    this._client = null;
    this._currentDeviceId = null;     // remember so we can disconnect with the same LWT topic
    this._canInboundHandler = null;   // null or fn(envelope) — set via subscribeCanInbound
    this._connectListeners = [];      // fn[] — fired on every broker connect (initial + reconnect)
  }

  /** Register a callback that fires every time the MQTT client successfully
   *  connects to the broker (initial connect AND every reconnect). Fires
   *  immediately if already connected when called. The state-store fan-out
   *  uses this to republish a snapshot so a slow probe at startup or a
   *  state change during a disconnect still ends up on the broker. */
  onConnect(fn) {
    if (typeof fn !== 'function') return;
    this._connectListeners.push(fn);
    if (this._client && this._client.connected) {
      try { fn(); } catch (e) { console.error('[mqtt] onConnect listener threw:', e.message); }
    }
  }

  /** Register a handler for can/inbound frames. Idempotent. Survives
   *  reconnect — the subscription is re-issued from _connect on every
   *  fresh client. Pass null to unsubscribe. */
  subscribeCanInbound(handler) {
    this._canInboundHandler = handler;
    if (this._client && this._client.connected && handler) {
      this._client.subscribe('can/inbound', { qos: 1 }, (err) => {
        if (err) console.error('[mqtt] subscribe can/inbound failed:', err.message);
      });
    }
  }

  /** Publish a CAN frame envelope on can/outbound. No-op when offline. */
  publishCanOutbound(envelope) {
    if (!this._client || !this._client.connected) return false;
    this._client.publish('can/outbound', JSON.stringify(envelope), { qos: 1 });
    return true;
  }

  /** Bring the bridge up. No-op if connection.json is missing. */
  async start() {
    const conn = this._opts.getConnection();
    if (!conn) {
      this._setConnState('unconfigured', null);
      return;
    }
    await this._connect(conn);
  }

  /** Reconfigure after the GUI writes new credentials. Atomic swap. */
  async reconfigure() {
    await this._teardown();
    await this.start();
  }

  /** Stop the bridge and disconnect cleanly. Used on daemon shutdown. */
  async stop() {
    await this._teardown(/* graceful */ true);
  }

  /** Publish a per-feature status payload (retained). Used by state-store fan-out. */
  publishStatus(feature, payload, { retain = true, qos = 1 } = {}) {
    if (!this._client || !this._client.connected) return;
    const t = topicStatus(this._currentDeviceId, feature);
    this._client.publish(t, JSON.stringify(payload), { retain, qos });
  }

  // ─────────────────────────────────────────────────────────────────────
  // internals
  // ─────────────────────────────────────────────────────────────────────

  async _connect(conn) {
    const deviceId = this._opts.getDeviceId();
    const deviceName = this._opts.getDeviceName();
    const version = this._opts.getVersion();
    this._currentDeviceId = deviceId;

    const lwtTopic = topicPresence(deviceId);
    const lwtPayload = JSON.stringify({
      online: false, name: deviceName, version, ts: Date.now(),
    });

    const options = {
      clientId: `playbill-${deviceId}-${process.pid}`,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 8000,
      username: conn.username,
      password: conn.password,
      will: {
        topic: lwtTopic,
        payload: lwtPayload,
        qos: 1,
        retain: true,
      },
    };

    if (conn.brokerUrl.startsWith('mqtts://')) {
      if (conn.caCertProvided) {
        try { options.ca = fs.readFileSync(CA_CERT_FILE); }
        catch (e) { console.error('[mqtt] CA cert unreadable:', e.message); }
      }
      if (conn.tlsCertHostname) {
        const expected = conn.tlsCertHostname;
        // Wrap the checkServerIdentity override so a SAN mismatch surfaces
        // a useful message — mqtt.js otherwise rebrands the failure as a
        // generic `self-signed certificate in certificate chain` which
        // masks the real cause (e.g. PWA delivered a tlsCertHostname that
        // doesn't match any cert SAN, common when the field is set to a
        // Docker-internal alias rather than the LAN hostname).
        options.checkServerIdentity = (_host, cert) => {
          const err = tls.checkServerIdentity(expected, cert);
          if (err) {
            const sans = (cert.subjectaltname || '').split(/,\s*/);
            console.error(
              `[mqtt] TLS hostname check failed: tlsCertHostname="${expected}" ` +
              `not in cert altnames [${sans.join('; ')}]. ` +
              `Either drop tlsCertHostname (the brokerUrl host probably ` +
              `already matches the cert SAN) or set it to one of the listed altnames.`,
            );
          }
          return err;
        };
      }
    }

    this._setConnState('connecting', null);

    const client = mqtt.connect(conn.brokerUrl, options);
    this._client = client;

    client.on('connect', () => {
      this._setConnState('connected', null);
      // Subscribe to our own command topics + the broadcast bucket.
      client.subscribe(topicCommandSub(deviceId), { qos: 1 }, (err) => {
        if (err) console.error('[mqtt] subscribe own commands failed:', err);
      });
      client.subscribe(topicCommandBroadcast(), { qos: 1 }, (err) => {
        if (err) console.error('[mqtt] subscribe broadcast commands failed:', err);
      });
      // Re-subscribe to can/inbound if the controller wired a CAN bridge.
      if (this._canInboundHandler) {
        client.subscribe('can/inbound', { qos: 1 }, (err) => {
          if (err) console.error('[mqtt] subscribe can/inbound failed:', err.message);
        });
      }
      // Announce presence with retain so PWAs that subscribe later see us.
      client.publish(
        lwtTopic,
        JSON.stringify({
          online: true, name: deviceName, version, hostname: require('os').hostname(), ts: Date.now(),
        }),
        { qos: 1, retain: true },
      );
      // Fire connect-listeners (state-store fan-out republishes a snapshot
      // here so any state mutated while we were disconnected — including
      // the initial volume probe that races startup — lands on the broker).
      for (const fn of this._connectListeners) {
        try { fn(); } catch (e) { console.error('[mqtt] onConnect listener threw:', e.message); }
      }
    });

    client.on('error', (err) => {
      console.error('[mqtt] error:', err.message);
      const host = (() => {
        try { return new URL(this._opts.getConnection().brokerUrl).hostname; }
        catch (_) { return 'Headwaters'; }
      })();
      const { classify } = require('./services/error-classify');
      const c = classify(err, { host, protocol: 'mqtt' });
      this._setConnState('error', c.message, c.kind);
    });

    client.on('close', () => {
      // Differentiate between deliberate teardown and a network drop.
      // mqtt.js will keep reconnecting; just reflect the state.
      if (this._client === client) this._setConnState('connecting', null);
    });

    client.on('message', (topic, message) => this._onIncoming(topic, message));
  }

  async _onIncoming(topic, message) {
    // Route CAN frames before the Playbill-command parse. The two topic
    // families are disjoint so order is purely a fast-path optimization.
    if (topic === 'can/inbound') {
      if (!this._canInboundHandler) return;
      let env;
      try { env = JSON.parse(message.toString('utf8')); }
      catch (e) { console.error('[mqtt] non-JSON can/inbound:', e.message); return; }
      try { await this._canInboundHandler(env); }
      catch (e) { console.error('[mqtt] can/inbound handler failed:', e.message); }
      return;
    }

    // Topic shape: local/playbill/<deviceOrAll>/<feature>/command
    const parts = topic.split('/');
    if (parts.length !== 5) return;
    const [, , deviceOrAll, feature, verb] = parts;
    if (verb !== 'command') return;

    const myId = this._opts.getDeviceId();
    if (deviceOrAll !== myId && deviceOrAll !== BROADCAST) return;

    let cmd;
    try { cmd = JSON.parse(message.toString('utf8')); }
    catch (e) { console.error(`[mqtt] non-JSON command on ${topic}:`, e.message); return; }

    if (!cmd || typeof cmd.action !== 'string') {
      console.error(`[mqtt] command on ${topic} missing action field`);
      return;
    }

    try {
      // The bus knows nothing about MQTT — it just gets a command. The
      // resulting state change will be published back via fan-out.
      await this._opts.commandBus.dispatch(cmd, { from: 'mqtt', topic, feature });
    } catch (e) {
      console.error(`[mqtt] dispatch failed for ${topic}:`, e.message);
    }
  }

  async _teardown(graceful = false) {
    const c = this._client;
    if (!c) return;
    this._client = null;
    if (graceful && this._currentDeviceId) {
      // Best-effort offline announcement before disconnect — overrides the
      // retained 'online: true' so observers see us as cleanly offline rather
      // than waiting for the LWT to fire.
      try {
        c.publish(
          topicPresence(this._currentDeviceId),
          JSON.stringify({ online: false, ts: Date.now() }),
          { qos: 1, retain: true },
        );
      } catch (_) { /* best-effort */ }
    }
    // Race the graceful drain against a hard cap. If the broker is
    // unreachable (DNS failure, network drop, wrong host like the
    // PWA-supplied 'bd81e3eeb809.local' Docker-internal name), c.end(false)
    // waits forever for an ack that never arrives. systemd then SIGKILLs us
    // after TimeoutStopSec, making restarts take a full 90 s. 2 s is plenty
    // for a healthy disconnect; anything past that means the network's gone
    // and we're better off forcing.
    await Promise.race([
      new Promise((resolve) => c.end(false, {}, resolve)),
      new Promise((resolve) => setTimeout(() => {
        try { c.end(true, {}, () => resolve()); } catch (_) { resolve(); }
      }, 2000)),
    ]);
  }

  _setConnState(status, lastError, lastErrorKind) {
    const cur = this._opts.stateStore.get();
    this._opts.stateStore.patch({
      connection: {
        ...(cur.connection || {}),
        status,
        lastError: lastError || null,
        lastErrorKind: lastErrorKind || null,
      },
    });
  }
}

module.exports = MqttBridge;
module.exports.topics = {
  TOPIC_ROOT, SUBSYSTEM, BROADCAST,
  commandSub: topicCommandSub,
  commandBroadcast: topicCommandBroadcast,
  status: topicStatus,
  presence: topicPresence,
};
module.exports.normalizeBrokerUrl = normalizeBrokerUrl;
module.exports.DEFAULT_MQTT_PORT  = DEFAULT_MQTT_PORT;
