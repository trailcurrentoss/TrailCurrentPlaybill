/* Playbill CAN bridge.
 *
 *   can/inbound  → decode (dbc-codec.js) → adapt to bus command → dispatch
 *   state.*      → adapt to DBC fields → encode → publish on can/outbound
 *
 * Per `docs/app/architecture.md §4`, Headwaters stays wire-only — it
 * shuttles raw frames between the can0 socket and the can/inbound /
 * can/outbound MQTT topics, and Playbill owns the DBC. This file is that
 * ownership.
 *
 * The DBC encode/decode lives in `../dbc-codec.js` (canonical, with
 * self-tests). This file is the small adapter layer between the codec's
 * numeric/enum-by-int fields and the command bus's typed-action vocabulary
 * defined in `schema/commands.schema.json`.
 *
 * Scope right now: radio only. Adding more inbound messages (NavCmd,
 * TransportCmd, SystemCmd, LaunchSourceCmd, VolumeCmd) is one entry in
 * INBOUND_ADAPTERS; adding more outbound (TransportStatus, ScreenStatus,
 * Presence) is one entry in OUTBOUND_FANOUTS.
 *
 * Multi-instance: Playbill picks one of three CAN address blocks
 * (`0x100-0x10F`, `0x110-0x11F`, `0x120-0x12F`) via `device.canInstance`.
 * `null` opts out — the bridge does nothing and the Playbill is MQTT-only.
 */

'use strict';

const codec  = require('../dbc-codec');
const topics = require('../topics');

// ── Inbound: DBC message name → (decoded fields, instance) → bus command ──
//
// Returning null/undefined drops the frame silently (out of band, missing
// required field, unsupported sub-action). The bus then re-validates the
// returned command against commands.schema.json before dispatch — so the
// adapter is allowed to be liberal about what it produces and the validator
// is the final gate.
const INBOUND_ADAPTERS = {

  PlaybillRadioTuneReq(fields /*, instance */) {
    // codec gives us band as the int enum value; the schema wants 'fm' | 'am' | 'scanner'.
    const band = bandIntToString(fields.band);
    if (!band) return null;
    const frequencyKHz = fields.frequencyKHz;
    if (!frequencyKHz || frequencyKHz < 1) return null;
    return {
      action: 'radio.tune',
      value: { band, frequencyHz: frequencyKHz * 1000 },
    };
  },

  // D-pad / soft-button presses from a remote-style CAN device. The bus
  // handler (handlers/nav.js) fans this out as an IPC event that the GUI's
  // renderer turns into a synthetic KeyboardEvent. When the GUI is offline,
  // the handler also fires system.launchGui so the first press wakes the box.
  PlaybillNavCmd(fields) {
    const key = navKeyIntToString(fields.navKey);
    if (!key) return null;
    return { action: 'nav.dpad', key };
  },

  // Lifecycle ops from any CAN device — most importantly LaunchGui so a
  // remote can power the Playbill GUI on without the user touching the
  // keyboard. The matching bus actions live in handlers/system.js.
  PlaybillSystemCmd(fields) {
    const action = sysActionIntToAction(fields.sysAction);
    if (!action) return null;
    return { action };
  },

  // Transport verbs. SeekRel/SeekAbs carry a uint32 value (ms); the simple
  // verbs ignore it. Play with no URL is a resume-current — pre-resolved
  // playback URLs don't fit in a CAN frame so we leave url/sourceId unset.
  PlaybillTransportCmd(fields) {
    const enumName = enumNameFromValue(codec.enums.TransportAction, fields.action);
    if (!enumName) return null;
    switch (enumName) {
      case 'Play':     return { action: 'transport.play' };
      case 'Pause':    return { action: 'transport.pause' };
      case 'Stop':     return { action: 'transport.stop' };
      case 'Toggle':   return { action: 'transport.toggle' };
      case 'Next':     return { action: 'transport.next' };
      case 'Previous': return { action: 'transport.previous' };
      case 'SeekRel': {
        // codec value is uint32; interpret as signed for relative seeks so a
        // remote can scrub backward without needing a separate verb.
        const v = fields.value | 0; // force signed-32 reinterpretation
        return { action: 'transport.seekRel', deltaMs: v };
      }
      case 'SeekAbs':  return { action: 'transport.seekAbs', positionMs: fields.value >>> 0 };
      default: return null;
    }
  },

  // Volume / mute. Up/Down ignore the value byte (uses schema default step);
  // Set uses the byte as a 0-100 percent. Mute verbs ignore the value.
  PlaybillVolumeCmd(fields) {
    const enumName = enumNameFromValue(codec.enums.VolAction, fields.volAction);
    if (!enumName) return null;
    switch (enumName) {
      case 'Up':         return { action: 'transport.volumeUp' };
      case 'Down':       return { action: 'transport.volumeDown' };
      case 'Set':        return { action: 'transport.volumeSet', percent: Math.max(0, Math.min(100, fields.value | 0)) };
      case 'MuteOn':     return { action: 'transport.muteOn' };
      case 'MuteOff':    return { action: 'transport.muteOff' };
      case 'MuteToggle': return { action: 'transport.muteToggle' };
      default: return null;
    }
  },

  // Deep-link a remote app tile. source.launch in handlers/source.js
  // auto-fires system.launchGui when the GUI is offline.
  PlaybillLaunchSourceCmd(fields) {
    const sourceId = sourceIdFromEnum(fields.sourceEnum);
    if (!sourceId) return null;
    const subScreen = subScreenFromEnum(fields.subScreenEnum) || 'default';
    return { action: 'source.launch', sourceId, subScreen };
  },
};

// ── Outbound: state slice → DBC fields ────────────────────────────────────
//
// Each entry watches one slice of state, computes a small stable snapshot
// for change detection, and produces the field object the codec expects on
// encode. We never publish unless the snapshot actually changed (or it's
// the bridge's initial post-connect republish).
const OUTBOUND_FANOUTS = [
  {
    messageName: 'PlaybillRadioStatus',
    selector(state) {
      const r = state.radio;
      if (!r) return { band: 0, frequencyKHz: 0, signalDbm: 0, tuned: false, scanning: false };
      return {
        band:         codec.enums.Band[capitalize(r.band)] != null ? codec.enums.Band[capitalize(r.band)] : 0,
        frequencyKHz: Math.max(0, Math.min(0xffffffff, Math.round((r.frequencyHz || 0) / 1000))),
        signalDbm:    clampSigned8(r.signalDbm != null ? Math.round(r.signalDbm) : 0),
        tuned:        !!r.running,
        scanning:     !!r.scanning,
      };
    },
    fieldsForEncode(snapshot) { return snapshot; },
  },

  // Future:
  //   PlaybillTransportStatus  ← state.nowPlaying + state.audio (Volume/Mute live in audio)
  //   PlaybillScreenStatus     ← state.ui.screen + state.ui.guiOpen
  //   PlaybillPresence         ← computed on a 60s interval (heartbeat, not state-driven)
];

// ── Bridge ────────────────────────────────────────────────────────────────

class CanBridge {
  /**
   * @param {object} opts
   * @param {import('../mqtt-bridge')} opts.mqtt
   * @param {import('../command-bus')} opts.commandBus
   * @param {import('../state-store')} opts.stateStore
   * @param {() => number|null} opts.getCanInstance
   */
  constructor({ mqtt, commandBus, stateStore, getCanInstance }) {
    this._mqtt        = mqtt;
    this._bus         = commandBus;
    this._state       = stateStore;
    this._getInstance = getCanInstance;
    this._instance    = null;
    this._lastSnapshot = new Map();   // messageName → JSON snapshot
    this._unsubscribeState = null;
    this._wired = false;
  }

  /** True iff start() succeeded and the bridge is active. */
  isActive() { return this._wired; }
  /** The CAN instance currently active (0/1/2) or null. */
  getInstance() { return this._wired ? this._instance : null; }

  /** Bring the bridge up. No-op when canInstance is null. Safe to call
   *  again after settings change — re-evaluates the instance. */
  start() {
    if (this._wired) this.stop();
    const instance = this._getInstance();
    if (instance == null) {
      console.log('[can-bridge] device.canInstance is null — CAN bridge disabled');
      return;
    }
    if (!Number.isInteger(instance) || instance < 0 || instance > 2) {
      console.warn(`[can-bridge] invalid device.canInstance=${instance} — CAN bridge disabled`);
      return;
    }
    this._instance = instance;
    const blockBase = codec.BLOCK_BASE[instance];
    console.log(`[can-bridge] starting on instance ${instance} (block 0x${blockBase.toString(16)}-0x${(blockBase + 0xf).toString(16)})`);

    // ── inbound ──
    this._mqtt.subscribeCanInbound((env) => this._onInbound(env));

    // ── outbound ──
    this._unsubscribeState = this._state.subscribe(({ state }) => this._onStateChange(state));
    // Publish an initial snapshot for every outbound message so any CAN
    // consumer that powered on first sees a coherent state instead of stale
    // bus silence after a controller restart.
    this._lastSnapshot.clear();
    this._onStateChange(this._state.get(), { force: true });

    this._wired = true;
  }

  stop() {
    this._mqtt.subscribeCanInbound(null);
    if (typeof this._unsubscribeState === 'function') {
      try { this._unsubscribeState(); } catch (_) { /* noop */ }
    }
    this._unsubscribeState = null;
    this._lastSnapshot = new Map();
    this._wired = false;
  }

  // ── inbound ────────────────────────────────────────────────────────

  async _onInbound(env) {
    const parsed = parseInboundEnvelope(env);
    if (!parsed) return;

    // Block filter: only act on frames addressed to this Playbill's instance.
    if (codec.instanceFromId(parsed.id) !== this._instance) return;

    let decoded;
    try { decoded = codec.decode(parsed.id, parsed.bytes); }
    catch (e) { console.warn('[can-bridge] decode failed:', e.message); return; }

    const adapter = INBOUND_ADAPTERS[decoded.messageName];
    if (!adapter) return;            // outbound-only message, or not wired yet

    let cmd;
    try { cmd = adapter(decoded.fields, decoded.instance); }
    catch (e) { console.error(`[can-bridge] ${decoded.messageName} adapter threw:`, e.message); return; }
    if (!cmd) return;

    try {
      await this._bus.dispatch(cmd, {
        from:     'can',
        canId:    parsed.id,
        message:  decoded.messageName,
        instance: decoded.instance,
      });
    } catch (e) {
      console.error(`[can-bridge] dispatch ${cmd.action} failed:`, e.message);
    }
  }

  // ── outbound ───────────────────────────────────────────────────────

  _onStateChange(state, { force = false } = {}) {
    for (const fan of OUTBOUND_FANOUTS) {
      let snapshot;
      try { snapshot = fan.selector(state); }
      catch (e) { console.error(`[can-bridge] ${fan.messageName} selector threw:`, e.message); continue; }
      if (snapshot == null) continue;

      const key = JSON.stringify(snapshot);
      const prev = this._lastSnapshot.get(fan.messageName);
      if (!force && prev === key) continue;
      this._lastSnapshot.set(fan.messageName, key);

      let encoded;
      try {
        const fields = fan.fieldsForEncode(snapshot);
        encoded = codec.encode(fan.messageName, this._instance, fields);
      } catch (e) {
        console.error(`[can-bridge] encode ${fan.messageName} failed:`, e.message);
        continue;
      }

      this._mqtt.publishCanOutbound(buildOutboundEnvelope(encoded.canId, encoded.data));
    }
  }
}

// ── MQTT wire envelope helpers ────────────────────────────────────────────
//
// The CAN-to-MQTT bridge (Headwaters' can-to-mqtt.py) and mqtt.js
// publishCanMessage both use the same JSON envelope: 8-byte bit-arrays
// MSB-first, hex identifier, dlc + extd/rtr/ss/self flags. These helpers
// keep that shape isolated from the codec (which works in raw byte
// Buffers) and from the rest of the bridge (which works in command/field
// objects).

function bytesToBitArrays(bytes) {
  const arr = new Array(8);
  for (let i = 0; i < 8; i++) {
    const b = i < bytes.length ? (bytes[i] & 0xff) : 0;
    const row = new Array(8);
    for (let j = 7; j >= 0; j--) row[7 - j] = (b >> j) & 1;
    arr[i] = row;
  }
  return arr;
}

function bitArraysToBytes(rows, dlc) {
  const n = Math.min(dlc != null ? dlc : rows.length, 8);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    const r = rows[i] || [];
    for (let j = 0; j < 8; j++) v |= ((r[j] & 1) << (7 - j));
    out[i] = v;
  }
  return out;
}

function buildOutboundEnvelope(canId, dataBuf) {
  const dlc = Math.min(dataBuf.length, 8);
  return {
    identifier: `0x${canId.toString(16)}`,
    data_length_code: dlc,
    data: bytesToBitArrays(dataBuf),
    extd: 0,
    rtr: 0,
    ss: 0,
    self: 0,
  };
}

function parseInboundEnvelope(msg) {
  if (!msg || typeof msg.identifier !== 'string' || !Array.isArray(msg.data)) return null;
  const id = parseInt(msg.identifier, 16);
  if (!Number.isFinite(id)) return null;
  const dlc = typeof msg.data_length_code === 'number' ? msg.data_length_code : msg.data.length;
  return { id, dlc, bytes: bitArraysToBytes(msg.data, dlc) };
}

// ── small helpers ─────────────────────────────────────────────────────────

function bandIntToString(n) {
  for (const [name, code] of Object.entries(codec.enums.Band)) {
    if (code === n) return name.toLowerCase();
  }
  return null;
}

function enumNameFromValue(enumObj, n) {
  if (!enumObj || !Number.isFinite(n)) return null;
  for (const [name, code] of Object.entries(enumObj)) {
    if (code === n) return name;
  }
  return null;
}

function navKeyIntToString(n) {
  const name = enumNameFromValue(codec.enums.NavKey, n);
  return name ? name.toLowerCase() : null;
}

const SYS_ACTION_TO_BUS = Object.freeze({
  LaunchGui: 'system.launchGui',
  QuitGui:   'system.quitGui',
  Focus:     'system.focus',
  Wake:      'system.wake',
  Sleep:     'system.sleep',
});
function sysActionIntToAction(n) {
  const name = enumNameFromValue(codec.enums.SysAction, n);
  return name ? SYS_ACTION_TO_BUS[name] : null;
}

const SOURCE_ENUM_TO_ID = Object.freeze({
  YouTube:      'youtube',
  LiveTV:       'livetv',
  Radio:        'radio',
  LocalLibrary: 'local',
  Plex:         'plex',
  Spotify:      'spotify',
  Netflix:      'netflix',
});
function sourceIdFromEnum(n) {
  const name = enumNameFromValue(codec.enums.Source, n);
  return name ? SOURCE_ENUM_TO_ID[name] : null;
}

function subScreenFromEnum(n) {
  const name = enumNameFromValue(codec.enums.SubScreen, n);
  return name ? name.toLowerCase() : null;
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function clampSigned8(n) {
  if (n >  127) return  127;
  if (n < -128) return -128;
  return n;
}

module.exports = CanBridge;
// Exposed for tests
module.exports._internal = { buildOutboundEnvelope, parseInboundEnvelope, INBOUND_ADAPTERS, OUTBOUND_FANOUTS };
// Note: tests should hit dbc-codec.js for the canonical codec self-tests.
// The MQTT-envelope helpers here are exercised end-to-end by integration.

// Topic constants are imported but the bridge itself doesn't publish to
// per-Playbill topics — those are owned by mqtt-bridge.js. We keep the
// reference live so a future surface (e.g. emit a deviceId on dispatch
// context) can use it without re-importing.
void topics;
