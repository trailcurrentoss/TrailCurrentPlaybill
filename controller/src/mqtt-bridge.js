/* MQTT bridge — connects to the rig broker, fans inbound commands into
   the command bus, fans outbound state changes onto retained topics.

   Topic layout (matches docs/app/architecture-v2.md §4):

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
        options.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(expected, cert);
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
    });

    client.on('error', (err) => {
      console.error('[mqtt] error:', err.message);
      this._setConnState('error', err.message);
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
    await new Promise((resolve) => c.end(false, {}, resolve));
  }

  _setConnState(status, lastError) {
    const cur = this._opts.stateStore.get();
    this._opts.stateStore.patch({
      connection: {
        ...(cur.connection || {}),
        status,
        lastError: lastError || null,
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
