/* MQTT topic constants — single source of truth.

   Topic shape (matches docs/app/architecture.md §4):

     local/playbill/<deviceId>/<feature>/{command,status}
     local/playbill/all/<feature>/command            broadcast
     can/inbound                                      raw CAN frame from Headwaters
     can/outbound                                     raw CAN frame to Headwaters

   All builders live here so a typo in one topic doesn't drift away from
   the topic the corresponding subscriber expects. Anything that publishes
   or subscribes uses these helpers, never inline strings. */

'use strict';

const ROOT      = 'local';
const SUBSYSTEM = 'playbill';
const BROADCAST = 'all';

// Verb constants (defined before any builder uses them).
const MSG = Object.freeze({ COMMAND: 'command', STATUS: 'status' });

// Feature segments — exactly the categories the state store and the MQTT
// fan-out (index.js installStateToMqttFanout) maintain.
const FEATURES = Object.freeze({
  SYSTEM:    'system',
  TRANSPORT: 'transport',
  NAV:       'nav',
  RADIO:     'radio',
  LIVETV:    'livetv',
  VOLUME:    'volume',
  SOURCE:    'source',
});

// ── Builders for one specific Playbill ───────────────────────────────

function command(deviceId, feature) { return `${ROOT}/${SUBSYSTEM}/${deviceId}/${feature}/command`; }
function status(deviceId, feature)  { return `${ROOT}/${SUBSYSTEM}/${deviceId}/${feature}/status`; }
function presence(deviceId)         { return status(deviceId, FEATURES.SYSTEM); }

// Per-source RPC topics (browse/resolve/search). MQTT-only — no DBC entry.
function sourceList(deviceId, sourceId, kind) {
  return `${ROOT}/${SUBSYSTEM}/${deviceId}/source/${sourceId}/${kind}`;
}

// ── Subscription patterns ────────────────────────────────────────────

// What the controller subscribes to: its own commands + the broadcast bucket.
function subscribePatterns(deviceId) {
  return [
    `${ROOT}/${SUBSYSTEM}/${deviceId}/+/command`,
    `${ROOT}/${SUBSYSTEM}/${BROADCAST}/+/command`,
  ];
}

// What a PWA subscribes to in order to discover all Playbills on the rig.
function discoveryPattern() {
  return `${ROOT}/${SUBSYSTEM}/+/${FEATURES.SYSTEM}/${MSG.STATUS}`;
}

// ── Raw CAN passthrough (Headwaters wire) ────────────────────────────

const CAN_INBOUND  = 'can/inbound';
const CAN_OUTBOUND = 'can/outbound';

// ── Parser: feature out of an incoming command topic ─────────────────
//
// Returns { deviceOrAll, feature } or null if the topic doesn't match
// the per-Playbill command shape.
function parseCommandTopic(topic) {
  const parts = topic.split('/');
  if (parts.length !== 5) return null;
  if (parts[0] !== ROOT || parts[1] !== SUBSYSTEM || parts[4] !== MSG.COMMAND) return null;
  return { deviceOrAll: parts[2], feature: parts[3] };
}

module.exports = {
  ROOT, SUBSYSTEM, BROADCAST, FEATURES, MSG,
  command, status, presence, sourceList,
  subscribePatterns, discoveryPattern, parseCommandTopic,
  CAN_INBOUND, CAN_OUTBOUND,
};
