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
  // Headwaters publishes its lights config as retained snapshots on these
  // topics; subscribing gives us names without an HTTP round-trip.
  CONFIG_SYNC:    'local/config/system_sync',
  PDM_CHANNELS:   'local/config/pdm_channels',     // Torrent PDM lights
  RELAY_CHANNELS: 'local/config/relay_channels',   // Switchback / relay-driven lights
  CONFIG_TRIGGER: 'local/config/system_sync_trigger',
};

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

// Merge a fresh authoritative list (from config snapshot or REST) with
// any live state/brightness we've already received over MQTT.
function mergeLightConfig(state, channels) {
  if (!Array.isArray(channels)) return;
  const cur = state.get().telemetry || emptyTelemetry();
  const byId = new Map((cur.lights || []).map((l) => [l.id, l]));
  const merged = channels.map((ch) => {
    const id = ch.id ?? ch._id;
    const prior = byId.get(id) || {};
    return {
      id,
      _id: id,
      name:   ch.name || prior.name || `Light ${id}`,
      icon:   ch.icon || prior.icon || 'lightbulb',
      type:   ch.type || prior.type || 'switch',
      source: ch.source || prior.source || 'pdm',
      state:      (typeof prior.state === 'number') ? prior.state : 0,
      brightness: (typeof prior.brightness === 'number') ? prior.brightness : 0,
    };
  });
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

  // Retained config snapshots from Headwaters carry the light NAMES that
  // the user configured in the PWA. Subscribing to both topics is cheap:
  // CONFIG_SYNC fires when cloud_enabled=true (and on demand via the
  // trigger topic), PDM_CHANNELS fires on any PDM channel mutation
  // regardless of cloud sync. Either one is sufficient for names.
  mqtt.subscribeTopic(TOPICS.CONFIG_SYNC, (_t, payload) => {
    if (payload && Array.isArray(payload.channels)) mergeLightConfig(state, payload.channels);
  });
  mqtt.subscribeTopic(TOPICS.PDM_CHANNELS, (_t, payload) => {
    if (payload && Array.isArray(payload.channels)) mergeLightConfig(state, payload.channels);
  });
  // Switchback / relay-driven lights live on a separate retained topic.
  // Without this subscription the UI would only show PDM/Torrent lights
  // and miss any relay-driven fixtures.
  mqtt.subscribeTopic(TOPICS.RELAY_CHANNELS, (_t, payload) => {
    if (payload && Array.isArray(payload.channels)) mergeLightConfig(state, payload.channels);
  });

  // Ask Headwaters to re-publish the snapshot once we're connected. The
  // request is idempotent — multiple Playbills firing it is harmless.
  // If 5 s after connect we still have no light list, fall back to the
  // HTTP /api/lights endpoint (which works regardless of cloud_enabled,
  // assuming an API key is configured).
  mqtt.onConnect(() => {
    mqtt.publishTopic(TOPICS.CONFIG_TRIGGER, { requested_by: 'playbill', ts: Date.now() }, { qos: 1, retain: false });
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
    patchLight(state, id, payload);
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
