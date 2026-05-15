/* telemetry.* — mirror Headwaters telemetry into state.telemetry.

   The Headwaters MQTT broker fans every hardware module's status updates
   onto well-known topics. Playbill is already connected to the same
   broker, so the cheapest path to live rig telemetry on the TV is to
   subscribe to those topics directly and merge the payloads into
   state.telemetry.{energy,water,climate,location}. The Rig view reads
   state.telemetry and re-renders on each delta.

   **Commands flow via MQTT, not Headwaters' HTTP API.** Light controllers
   (Torrent, Switchback, etc.) and the Headwaters backend both listen on
   `local/lights/<id>/command` and `local/lights/all/command`. The HTTP
   API is just an internal-PWA shim that publishes to those same topics.
   Playbill is already on the broker, so it cuts out the middleman: no
   bearer token needed, no HTTPS round-trip, no Mongo lookup.

   Light NAMES come from Headwaters' MongoDB `lights` collection. The MQTT
   status broadcast only carries id/state/brightness, not name — so we
   hit Headwaters' /api/lights once on connect (and every 30 s) just to
   resolve names + icons + source. If no API key is configured, the UI
   still works: it shows "Light <id>" placeholders and commands fire. */

'use strict';

const https = require('https');
const fs    = require('fs');

const headwatersHandlers = require('./headwaters');
const headwatersApi      = require('../services/headwaters-api');
const { CA_CERT_FILE }   = require('../paths');

const LIGHTS_POLL_MS = 30000;
const HTTP_TIMEOUT_MS = 8000;

// Topics we mirror. Patterns must match what Headwaters publishes — see
// containers/backend/src/mqtt.js TOPICS constants.
const TOPICS = {
  ENERGY:         'local/energy/status',
  AIRQUALITY:     'local/airquality/status',
  TEMPHUMID:      'local/airquality/temphumid',
  GPS_LATLON:     'local/gps/latlon',
  GPS_ALT:        'local/gps/alt',
  GPS_DETAILS:    'local/gps/details',
  WATER:          'local/water/status',
  LIGHT_STATUS:   'local/lights/+/status',
  // Switchback relays publish their state on local/relays/<id>/status, NOT
  // on local/lights/.../status. Without this subscription a relay toggled
  // from the PWA (or any other client) would never reflect in the Rig view.
  RELAY_STATUS:   'local/relays/+/status',
  // Headwaters publishes its lights config as retained snapshots on these
  // topics; subscribing gives us names without an HTTP round-trip.
  CONFIG_SYNC:    'local/config/system_sync',
  PDM_CHANNELS:   'local/config/pdm_channels',     // Torrent PDM lights
  RELAY_CHANNELS: 'local/config/relay_channels',   // Switchback / relay-driven lights
  // `local/config/request` always works (Headwaters re-publishes channel
  // configs on demand). `system_sync_trigger` only fires when cloud_enabled.
  CONFIG_REQUEST: 'local/config/request',
};

// Switchback lights live at IDs 100 + relay_id in the Headwaters lights
// collection (see services/switchback-channel-sync.js). The matching MQTT
// status topic is local/relays/<relay_id>/status where relay_id is global
// across all switchback instances (1-8 for instance 0, 9-16 for instance 1,
// 17-24 for instance 2 — see can-bridge.js parseRelayStatus).
const SWITCHBACK_ID_BASE = 100;

function emptyTelemetry() {
  return {
    energy:   null,
    water:    null,
    climate:  null,   // tempInF / tempInC / humidity
    air:      null,   // tvoc_ppb / eco2_ppm
    location: null,   // latitude / longitude / altitudeFeet / numberOfSatellites
    lights:   [],     // [{ id, name, state, brightness, icon, type, source }]
    lightsUpdatedAt: null,
  };
}

function mergeSlice(state, slice, payload) {
  const cur = state.get().telemetry || emptyTelemetry();
  const merged = { ...cur, [slice]: { ...(cur[slice] || {}), ...payload, ts: Date.now() } };
  state.patch({ telemetry: merged });
}

function setLights(state, list) {
  const cur = state.get().telemetry || emptyTelemetry();
  state.patch({ telemetry: { ...cur, lights: list, lightsUpdatedAt: Date.now() } });
}

// Merge a fresh authoritative list (from a single config topic) with the
// lights we already know about. The PDM_CHANNELS and RELAY_CHANNELS topics
// each carry only their own slice, so we must NOT clobber the other slice
// when one of them arrives — `sourceTag` says which slice the incoming
// channels belong to and any prior lights with that tag get replaced
// while the other slice is preserved. Pass sourceTag='*' (or omit) for a
// unified snapshot (CONFIG_SYNC / REST /api/lights) that authoritatively
// describes every light.
function mergeLightConfig(state, channels, sourceTag) {
  if (!Array.isArray(channels)) return;
  const cur = state.get().telemetry || emptyTelemetry();
  const priorById = new Map((cur.lights || []).map((l) => [l.id, l]));

  // Tag each incoming entry with the source slice it came from. The
  // published payloads don't always carry a `source` field, so we infer:
  // a `relay_channel` field means switchback; otherwise pdm.
  function tagFor(ch) {
    return ch.source
      || (ch.relay_channel !== undefined ? 'switchback' : 'pdm');
  }

  const incoming = channels.map((ch) => {
    const id = ch.id ?? ch._id;
    const prior = priorById.get(id) || {};
    return {
      id,
      _id: id,
      name:   ch.name || prior.name || `Light ${id}`,
      icon:   ch.icon || prior.icon || 'lightbulb',
      type:   ch.type || prior.type || 'switch',
      source: tagFor(ch),
      state:      (typeof prior.state === 'number') ? prior.state : 0,
      brightness: (typeof prior.brightness === 'number') ? prior.brightness : 0,
    };
  });

  // Build the merged list: drop any prior light whose slice we're now
  // replacing, then add the incoming entries. With sourceTag='*' that
  // drops everything; with a specific tag it only drops that slice.
  const incomingIds = new Set(incoming.map((l) => l.id));
  const survivors = (cur.lights || []).filter((l) => {
    if (sourceTag === '*' || !sourceTag) return false;     // full replace
    if (incomingIds.has(l.id))           return false;     // updated in place
    return l.source !== sourceTag;                          // keep other slices
  });
  const merged = survivors.concat(incoming).sort((a, b) => a.id - b.id);

  state.patch({ telemetry: { ...cur, lights: merged, lightsUpdatedAt: Date.now() } });
}

function patchLight(state, id, partial) {
  const cur = state.get().telemetry || emptyTelemetry();
  const lights = (cur.lights || []).slice();
  const idx = lights.findIndex((l) => l.id === id);
  if (idx >= 0) {
    lights[idx] = { ...lights[idx], ...partial };
  } else {
    // First time we've seen this id over MQTT and the REST list hasn't
    // landed yet — keep a placeholder so the user sees activity.
    lights.push({ id, _id: id, name: `Light ${id}`, ...partial });
  }
  state.patch({ telemetry: { ...cur, lights } });
}

// ─── Headwaters HTTPS calls ───────────────────────────────────────────

function httpsJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      timeout: HTTP_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
      ...opts,
    };
    try {
      if (fs.existsSync(CA_CERT_FILE)) options.ca = fs.readFileSync(CA_CERT_FILE);
    } catch (_) { /* fall back to system store */ }
    const req = https.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`bad JSON from ${url}: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchLights(state) {
  const key = await headwatersHandlers.getApiKey();
  if (!key) return null;
  const url = headwatersApi.apiUrl(state, '/api/lights');
  return httpsJson(url, { headers: { Authorization: key, Accept: 'application/json' } });
}

// ─── Public registration ──────────────────────────────────────────────

function register({ bus, state, mqtt }) {
  // Seed state.telemetry so the renderer doesn't have to handle null.
  if (!state.get().telemetry) state.patch({ telemetry: emptyTelemetry() });

  // MQTT subscriptions — replay on every connect via subscribeTopic's
  // own reconnect handling.
  mqtt.subscribeTopic(TOPICS.ENERGY, (_t, payload) => {
    if (payload && typeof payload === 'object') mergeSlice(state, 'energy', payload);
  });
  mqtt.subscribeTopic(TOPICS.AIRQUALITY, (_t, payload) => {
    if (payload && typeof payload === 'object') mergeSlice(state, 'air', payload);
  });
  mqtt.subscribeTopic(TOPICS.TEMPHUMID, (_t, payload) => {
    if (payload && typeof payload === 'object') mergeSlice(state, 'climate', payload);
  });
  mqtt.subscribeTopic(TOPICS.GPS_LATLON, (_t, payload) => {
    if (payload && typeof payload === 'object') mergeSlice(state, 'location', payload);
  });
  mqtt.subscribeTopic(TOPICS.GPS_ALT, (_t, payload) => {
    if (payload && typeof payload === 'object') mergeSlice(state, 'location', payload);
  });
  mqtt.subscribeTopic(TOPICS.GPS_DETAILS, (_t, payload) => {
    if (payload && typeof payload === 'object') mergeSlice(state, 'location', payload);
  });
  mqtt.subscribeTopic(TOPICS.WATER, (_t, payload) => {
    if (payload && typeof payload === 'object') mergeSlice(state, 'water', payload);
  });
  // local/lights/<id>/status — payload {state, brightness}
  // Authoritative source for PDM/Torrent light state. We never patch from
  // our own command emit — every UI update flows through here so a toggle
  // from the PWA, a CAN bus button, or another Playbill reflects the same.
  mqtt.subscribeTopic(TOPICS.LIGHT_STATUS, (topic, payload) => {
    const parts = topic.split('/');
    const id = parseInt(parts[2], 10);
    if (!Number.isFinite(id)) return;
    const next = {};
    if (payload && typeof payload === 'object') {
      if (typeof payload.state === 'number')      next.state      = payload.state;
      if (typeof payload.brightness === 'number') next.brightness = payload.brightness;
    }
    if (Object.keys(next).length) patchLight(state, id, next);
  });
  // local/relays/<id>/status — payload {state}
  // Switchback hardware publishes here (via can-bridge parsing of CAN
  // 0x028/0x029/0x02a). Headwaters' lights collection assigns these
  // SWITCHBACK_ID_BASE + relayId in its lights table, so we translate the
  // topic id back into the matching light id.
  mqtt.subscribeTopic(TOPICS.RELAY_STATUS, (topic, payload) => {
    const parts = topic.split('/');
    const relayId = parseInt(parts[2], 10);
    if (!Number.isFinite(relayId)) return;
    if (!payload || typeof payload !== 'object' || typeof payload.state !== 'number') return;
    patchLight(state, SWITCHBACK_ID_BASE + relayId, { state: payload.state });
  });

  // Retained config snapshots from Headwaters carry the light NAMES that
  // the user configured in the PWA. CONFIG_SYNC is the unified snapshot
  // (cloud_enabled rigs only); PDM_CHANNELS / RELAY_CHANNELS each carry
  // their own slice and fire regardless of cloud sync. The two slice
  // topics are tagged so receiving one doesn't blow away the other.
  mqtt.subscribeTopic(TOPICS.CONFIG_SYNC, (_t, payload) => {
    if (payload && Array.isArray(payload.channels)) mergeLightConfig(state, payload.channels, '*');
  });
  mqtt.subscribeTopic(TOPICS.PDM_CHANNELS, (_t, payload) => {
    if (payload && Array.isArray(payload.channels)) mergeLightConfig(state, payload.channels, 'pdm');
  });
  // Switchback / relay-driven lights live on a separate retained topic.
  // Without this subscription the UI would only show PDM/Torrent lights
  // and miss any relay-driven fixtures.
  mqtt.subscribeTopic(TOPICS.RELAY_CHANNELS, (_t, payload) => {
    if (payload && Array.isArray(payload.channels)) mergeLightConfig(state, payload.channels, 'switchback');
  });

  // Ask Headwaters to re-publish the snapshot once we're connected. The
  // request is idempotent — multiple Playbills firing it is harmless.
  // Use local/config/request (always re-publishes PDM + relay channel
  // configs) rather than system_sync_trigger (only fires when cloud_enabled,
  // so silent no-op on offline rigs). If 5 s after connect we still have
  // no light list, fall back to the HTTP /api/lights endpoint.
  mqtt.onConnect(() => {
    mqtt.publishTopic(TOPICS.CONFIG_REQUEST, { requested_by: 'playbill', ts: Date.now() }, { qos: 1, retain: false });
    const t = setTimeout(() => {
      const cur = (state.get().telemetry && state.get().telemetry.lights) || [];
      if (cur.length === 0) {
        console.log('[telemetry] no light config from MQTT after 5 s — trying HTTP fallback');
        refreshLights();
      }
    }, 5000);
    if (t && t.unref) t.unref();
  });

  // HTTP /api/lights is the last-resort fallback when neither MQTT
  // snapshot topic carries data (e.g. Headwaters hasn't been configured
  // for cloud sync AND has no PDM modules yet). Not polled — we rely on
  // the retained MQTT snapshots above. Invoked manually via the
  // telemetry.lights.refresh bus action.
  async function refreshLights() {
    try {
      const list = await fetchLights(state);
      if (!Array.isArray(list)) return;
      mergeLightConfig(state, list);
    } catch (e) {
      if (!refreshLights._loggedAt || Date.now() - refreshLights._loggedAt > 60000) {
        refreshLights._loggedAt = Date.now();
        console.warn('[telemetry] fetchLights fallback failed:', e.message);
      }
    }
  }

  // ─── Bus commands ────────────────────────────────────────────────

  bus.register('telemetry.get', async () => state.get().telemetry || emptyTelemetry());

  bus.register('telemetry.lights.refresh', async () => {
    await refreshLights();
    return { ok: true };
  });

  // Toggle / set a single light. value: { id, state, brightness? }
  // Publishes to local/lights/<id>/command — the same topic the Headwaters
  // backend and PDM modules listen on. No HTTP, no API key, no middleman.
  // We deliberately do NOT optimistically patch local state: the UI must
  // reflect the *device's* state, not Playbill's intent. The matching
  // status message (local/lights/<id>/status or local/relays/<id>/status
  // for switchback) is the authoritative update path and works the same
  // whether the toggle came from Playbill, the PWA, or a CAN button.
  bus.register('telemetry.lights.set', async (cmd) => {
    const v = cmd && cmd.value || {};
    const id = parseInt(v.id, 10);
    if (!Number.isFinite(id)) throw new Error('telemetry.lights.set: id required');
    const payload = {};
    if (typeof v.state === 'number') payload.state = v.state;
    if (typeof v.brightness === 'number') payload.brightness = v.brightness;
    if (!('state' in payload) && !('brightness' in payload)) {
      throw new Error('telemetry.lights.set: state and/or brightness required');
    }
    const topic = `local/lights/${id}/command`;
    const ok = mqtt.publishTopic(topic, payload, { qos: 1, retain: false });
    console.log(`[telemetry] publish ${topic} ${JSON.stringify(payload)} ok=${ok}`);
    if (!ok) throw new Error('MQTT broker not connected');
    return { ok: true };
  });

  // All-on / all-off.
  bus.register('telemetry.lights.setAll', async (cmd) => {
    const v = cmd && cmd.value || {};
    if (typeof v.state !== 'number') throw new Error('telemetry.lights.setAll: state required');
    const ok = mqtt.publishTopic('local/lights/all/command', { state: v.state }, { qos: 1, retain: false });
    console.log(`[telemetry] publish local/lights/all/command state=${v.state} ok=${ok}`);
    if (!ok) throw new Error('MQTT broker not connected');
    return { ok: true };
  });
}

module.exports = { register };
