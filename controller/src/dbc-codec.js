/* DBC codec — encode/decode for the Playbill messages defined in
   docs/app/dbc-additions.md.

   Headwaters is a wire-only passthrough: it shovels raw frames between
   CAN and MQTT without parsing. Endpoints (Bearing for GPS, Solstice
   for MPPT, and now Playbill) own their own encoding. This module is
   Playbill's side of that contract.

   Implementation note: deliberately hand-rolled rather than DBC-file
   driven. We have ten messages, all byte-aligned or simple bit-packed
   into the leading byte. A generic DBC parser would be more lines and
   harder to verify against the layout doc. When the shared
   TrailCurrentCANLibrary lands, this swaps to the parsed approach.

   Scope:
     - 10 message types × 3 instances = 30 CAN IDs
     - Inbound (→ Playbill): NavCmd, TransportCmd, RadioTuneReq,
       SystemCmd, LaunchSourceCmd, VolumeCmd
     - Outbound (← Playbill): TransportStatus, RadioStatus,
       ScreenStatus, Presence

   API:
     encode(messageName, instance, fields) → { canId, data: Buffer }
     decode(canId, data: Buffer)            → { messageName, instance, fields }
     enums                                  → frozen lookup tables
     allCanIds()                            → [...30 numbers] — for subscribers
     instanceFromId(canId)                  → 0|1|2|null
     baseOffsetFromId(canId)                → 0..15 — local offset within block */

'use strict';

// ── ID layout ─────────────────────────────────────────────────────────

const BLOCK_BASE = [0x100, 0x110, 0x120];   // instance 0, 1, 2
const BLOCK_SIZE = 0x10;

// Local offsets within an instance block (per dbc-additions.md §3).
const OFFSETS = Object.freeze({
  PlaybillNavCmd:           0x0,
  PlaybillTransportCmd:     0x1,
  PlaybillTransportStatus:  0x2,
  PlaybillRadioTuneReq:     0x3,
  PlaybillRadioStatus:      0x4,
  PlaybillScreenStatus:     0x5,
  PlaybillSystemCmd:        0x6,
  PlaybillLaunchSourceCmd:  0x7,
  PlaybillVolumeCmd:        0x8,
  PlaybillPresence:         0x9,
});

// ── Enums ─────────────────────────────────────────────────────────────

const NavKey = Object.freeze({
  Up: 0, Down: 1, Left: 2, Right: 3, Select: 4, Back: 5, Home: 6, Menu: 7,
});

const TransportAction = Object.freeze({
  Play: 0, Pause: 1, Stop: 2, Toggle: 3, SeekRel: 4, SeekAbs: 5, Next: 6, Previous: 7,
});

const Source = Object.freeze({
  None: 0, YouTube: 1, LiveTV: 2, Radio: 3, LocalLibrary: 4, Plex: 5, Spotify: 6, Netflix: 7,
});

const Band = Object.freeze({ FM: 0, AM: 1, Scanner: 2 });

const Screen = Object.freeze({
  Home: 0, Apps: 1, Live: 2, Radio: 3, LocalLibrary: 4, Rig: 5, Settings: 6, NowPlaying: 7,
});

const SysAction = Object.freeze({
  LaunchGui: 0, QuitGui: 1, Focus: 2, Wake: 3, Sleep: 4,
});

const SubScreen = Object.freeze({
  Default: 0, SignIn: 1, Settings: 2, Search: 3,
});

const VolAction = Object.freeze({
  Up: 0, Down: 1, Set: 2, MuteOn: 3, MuteOff: 4, MuteToggle: 5,
});

// ── Helpers ───────────────────────────────────────────────────────────

function canIdFor(messageName, instance) {
  if (instance < 0 || instance > 2) throw new Error(`canIdFor: invalid instance ${instance}`);
  const off = OFFSETS[messageName];
  if (off === undefined) throw new Error(`canIdFor: unknown message ${messageName}`);
  return BLOCK_BASE[instance] + off;
}

function instanceFromId(canId) {
  for (let i = 0; i < BLOCK_BASE.length; i++) {
    if (canId >= BLOCK_BASE[i] && canId < BLOCK_BASE[i] + BLOCK_SIZE) return i;
  }
  return null;
}

function baseOffsetFromId(canId) {
  const inst = instanceFromId(canId);
  if (inst === null) return null;
  return canId - BLOCK_BASE[inst];
}

function messageNameFromId(canId) {
  const off = baseOffsetFromId(canId);
  if (off === null) return null;
  for (const [name, o] of Object.entries(OFFSETS)) if (o === off) return name;
  return null;
}

function allCanIds() {
  const ids = [];
  for (const base of BLOCK_BASE) for (const off of Object.values(OFFSETS)) ids.push(base + off);
  return ids;
}

function u8(v)  { if (v < 0 || v > 0xFF)         throw new Error(`u8 OOR: ${v}`);         return v & 0xFF; }
function u16(v) { if (v < 0 || v > 0xFFFF)       throw new Error(`u16 OOR: ${v}`);        return v & 0xFFFF; }
function u32(v) { if (v < 0 || v > 0xFFFFFFFF)   throw new Error(`u32 OOR: ${v}`);        return v >>> 0; }
function u24(v) { if (v < 0 || v > 0xFFFFFF)     throw new Error(`u24 OOR: ${v}`);        return v & 0xFFFFFF; }
function s8(v)  { if (v < -128 || v > 127)       throw new Error(`s8 OOR: ${v}`);         return v < 0 ? v + 256 : v; }
function bit(v) { return v ? 1 : 0; }

// ── Per-message encoders / decoders ───────────────────────────────────

const ENCODERS = {

  PlaybillNavCmd({ navKey }) {
    const buf = Buffer.alloc(1);
    buf[0] = u8(navKey);
    return buf;
  },

  PlaybillTransportCmd({ action, value = 0 }) {
    const buf = Buffer.alloc(5);
    buf[0] = u8(action);
    buf.writeUInt32BE(u32(value), 1);
    return buf;
  },

  PlaybillTransportStatus({ paused, muted, sourceEnum, volumePct, positionSec, durationSec }) {
    const buf = Buffer.alloc(8);
    // byte 0: P M SSSSSS
    buf[0] = (bit(paused) << 7) | (bit(muted) << 6) | (u8(sourceEnum) & 0x3F);
    buf[1] = u8(volumePct);
    buf[2] = (u24(positionSec) >> 16) & 0xFF;
    buf[3] = (u24(positionSec) >> 8)  & 0xFF;
    buf[4] =  u24(positionSec)        & 0xFF;
    buf[5] = (u24(durationSec) >> 16) & 0xFF;
    buf[6] = (u24(durationSec) >> 8)  & 0xFF;
    buf[7] =  u24(durationSec)        & 0xFF;
    return buf;
  },

  PlaybillRadioTuneReq({ band, frequencyKHz, mode = 0 }) {
    const buf = Buffer.alloc(6);
    buf[0] = u8(band);
    buf.writeUInt32BE(u32(frequencyKHz), 1);
    buf[5] = u8(mode);
    return buf;
  },

  PlaybillRadioStatus({ band, frequencyKHz, signalDbm, tuned, scanning }) {
    const buf = Buffer.alloc(8);
    buf[0] = u8(band);
    buf.writeUInt32BE(u32(frequencyKHz), 1);
    buf[5] = s8(signalDbm);
    // byte 6 bit 7 = Tuned, bit 6 = Scanning, rest reserved
    buf[6] = (bit(tuned) << 7) | (bit(scanning) << 6);
    buf[7] = 0;
    return buf;
  },

  PlaybillScreenStatus({ screenEnum, guiOpen }) {
    const buf = Buffer.alloc(2);
    buf[0] = u8(screenEnum);
    buf[1] = bit(guiOpen) << 7;
    return buf;
  },

  PlaybillSystemCmd({ sysAction }) {
    const buf = Buffer.alloc(1);
    buf[0] = u8(sysAction);
    return buf;
  },

  PlaybillLaunchSourceCmd({ sourceEnum, subScreenEnum = 0 }) {
    const buf = Buffer.alloc(2);
    buf[0] = u8(sourceEnum);
    buf[1] = u8(subScreenEnum);
    return buf;
  },

  PlaybillVolumeCmd({ volAction, value = 0 }) {
    const buf = Buffer.alloc(2);
    buf[0] = u8(volAction);
    buf[1] = u8(value);
    return buf;
  },

  PlaybillPresence({ macTail, versionMajor, versionMinor, versionPatch }) {
    if (!Array.isArray(macTail) || macTail.length !== 3) {
      throw new Error('PlaybillPresence: macTail must be [b4, b5, b6]');
    }
    const buf = Buffer.alloc(6);
    buf[0] = u8(macTail[0]);
    buf[1] = u8(macTail[1]);
    buf[2] = u8(macTail[2]);
    buf[3] = u8(versionMajor);
    buf[4] = u8(versionMinor);
    buf[5] = u8(versionPatch);
    return buf;
  },
};

const DECODERS = {

  PlaybillNavCmd(buf) {
    return { navKey: buf[0] };
  },

  PlaybillTransportCmd(buf) {
    return { action: buf[0], value: buf.readUInt32BE(1) };
  },

  PlaybillTransportStatus(buf) {
    return {
      paused:      !!(buf[0] & 0x80),
      muted:       !!(buf[0] & 0x40),
      sourceEnum:  buf[0] & 0x3F,
      volumePct:   buf[1],
      positionSec: (buf[2] << 16) | (buf[3] << 8) | buf[4],
      durationSec: (buf[5] << 16) | (buf[6] << 8) | buf[7],
    };
  },

  PlaybillRadioTuneReq(buf) {
    return { band: buf[0], frequencyKHz: buf.readUInt32BE(1), mode: buf[5] };
  },

  PlaybillRadioStatus(buf) {
    const sig = buf[5];
    return {
      band: buf[0],
      frequencyKHz: buf.readUInt32BE(1),
      signalDbm: sig > 127 ? sig - 256 : sig,
      tuned:    !!(buf[6] & 0x80),
      scanning: !!(buf[6] & 0x40),
    };
  },

  PlaybillScreenStatus(buf) {
    return { screenEnum: buf[0], guiOpen: !!(buf[1] & 0x80) };
  },

  PlaybillSystemCmd(buf) {
    return { sysAction: buf[0] };
  },

  PlaybillLaunchSourceCmd(buf) {
    return { sourceEnum: buf[0], subScreenEnum: buf[1] };
  },

  PlaybillVolumeCmd(buf) {
    return { volAction: buf[0], value: buf[1] };
  },

  PlaybillPresence(buf) {
    return {
      macTail: [buf[0], buf[1], buf[2]],
      versionMajor: buf[3], versionMinor: buf[4], versionPatch: buf[5],
    };
  },
};

// ── Public API ────────────────────────────────────────────────────────

function encode(messageName, instance, fields) {
  const enc = ENCODERS[messageName];
  if (!enc) throw new Error(`encode: unknown message "${messageName}"`);
  const data = enc(fields || {});
  const canId = canIdFor(messageName, instance);
  return { canId, data };
}

function decode(canId, data) {
  const messageName = messageNameFromId(canId);
  if (!messageName) throw new Error(`decode: CAN id 0x${canId.toString(16)} not in Playbill range`);
  const dec = DECODERS[messageName];
  if (!dec) throw new Error(`decode: no decoder for ${messageName}`);
  if (!Buffer.isBuffer(data)) throw new Error('decode: data must be a Buffer');
  return { messageName, instance: instanceFromId(canId), fields: dec(data) };
}

module.exports = {
  encode,
  decode,
  enums: { NavKey, TransportAction, Source, Band, Screen, SysAction, SubScreen, VolAction },
  canIdFor,
  instanceFromId,
  baseOffsetFromId,
  messageNameFromId,
  allCanIds,
  OFFSETS,
  BLOCK_BASE,
};

// ── Self-test (run with `node dbc-codec.js`) ─────────────────────────

if (require.main === module) {
  const assert = require('assert');
  let ok = 0, fail = 0;
  function t(name, fn) {
    try { fn(); ok++; console.log(`✓ ${name}`); }
    catch (e) { fail++; console.error(`✗ ${name}\n   ${e.message}`); }
  }

  t('NavCmd round-trip', () => {
    const { canId, data } = encode('PlaybillNavCmd', 1, { navKey: NavKey.Down });
    assert.strictEqual(canId, 0x110);
    const dec = decode(canId, data);
    assert.strictEqual(dec.messageName, 'PlaybillNavCmd');
    assert.strictEqual(dec.instance, 1);
    assert.strictEqual(dec.fields.navKey, NavKey.Down);
  });

  t('TransportCmd Seek round-trip with 32-bit value', () => {
    const { canId, data } = encode('PlaybillTransportCmd', 0,
      { action: TransportAction.SeekAbs, value: 1234567890 });
    assert.strictEqual(canId, 0x101);
    assert.strictEqual(data.length, 5);
    const dec = decode(canId, data);
    assert.strictEqual(dec.fields.action, TransportAction.SeekAbs);
    assert.strictEqual(dec.fields.value, 1234567890);
  });

  t('TransportStatus packs flags + source into byte 0', () => {
    const { data } = encode('PlaybillTransportStatus', 2, {
      paused: true, muted: false, sourceEnum: Source.YouTube,
      volumePct: 75, positionSec: 90, durationSec: 360,
    });
    // byte 0: 1 0 000001 = 0x81
    assert.strictEqual(data[0], 0x81);
    assert.strictEqual(data[1], 75);
    const dec = decode(canIdFor('PlaybillTransportStatus', 2), data);
    assert.deepStrictEqual(dec.fields, {
      paused: true, muted: false, sourceEnum: Source.YouTube,
      volumePct: 75, positionSec: 90, durationSec: 360,
    });
  });

  t('RadioTuneReq encodes 97500 kHz on FM', () => {
    const { canId, data } = encode('PlaybillRadioTuneReq', 0,
      { band: Band.FM, frequencyKHz: 97500 });
    assert.strictEqual(canId, 0x103);
    assert.strictEqual(data[0], Band.FM);
    assert.strictEqual(data.readUInt32BE(1), 97500);
  });

  t('RadioStatus signed dBm round-trips correctly', () => {
    const { canId, data } = encode('PlaybillRadioStatus', 0,
      { band: Band.FM, frequencyKHz: 88100, signalDbm: -85, tuned: true, scanning: false });
    const dec = decode(canId, data);
    assert.strictEqual(dec.fields.signalDbm, -85);
    assert.strictEqual(dec.fields.tuned, true);
    assert.strictEqual(dec.fields.scanning, false);
  });

  t('VolumeCmd Up step 5', () => {
    const { canId, data } = encode('PlaybillVolumeCmd', 1, { volAction: VolAction.Up, value: 5 });
    assert.strictEqual(canId, 0x118);
    assert.strictEqual(data[0], VolAction.Up);
    assert.strictEqual(data[1], 5);
    const dec = decode(canId, data);
    assert.strictEqual(dec.fields.volAction, VolAction.Up);
    assert.strictEqual(dec.fields.value, 5);
  });

  t('Presence mirrors firmware report shape (6 bytes)', () => {
    const { data } = encode('PlaybillPresence', 0, {
      macTail: [0xAA, 0xBB, 0xCC], versionMajor: 0, versionMinor: 1, versionPatch: 0,
    });
    assert.strictEqual(data.length, 6);
    assert.deepStrictEqual([...data], [0xAA, 0xBB, 0xCC, 0, 1, 0]);
  });

  t('allCanIds returns 30 ids and instanceFromId reverses', () => {
    const ids = allCanIds();
    assert.strictEqual(ids.length, 30);
    assert.strictEqual(instanceFromId(0x100), 0);
    assert.strictEqual(instanceFromId(0x115), 1);
    assert.strictEqual(instanceFromId(0x129), 2);
    assert.strictEqual(instanceFromId(0x200), null);
  });

  t('decode rejects out-of-range CAN ids', () => {
    assert.throws(() => decode(0x050, Buffer.from([0])));
  });

  t('encode rejects unknown message name', () => {
    assert.throws(() => encode('NotAMessage', 0, {}));
  });

  console.log(`\n${ok} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
