#!/usr/bin/env node
/* playbill-controller — daemon entry.

   Phase 1: bring up the spine (state store, command bus, IPC server,
   settings stores). MQTT and source plugins land in subsequent phases.

   Lifecycle:
     1. Load settings + connection from disk (may be missing on first run).
     2. Initialize state store with whatever we found.
     3. Register the system command handlers (the only handlers needed
        before MQTT is wired).
     4. Open the IPC socket so the GUI can connect and finish setup.
     5. Wait for SIGTERM/SIGINT, shutdown cleanly. */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const StateStore  = require('./state-store');
const CommandBus  = require('./command-bus');
const IpcServer   = require('./ipc-server');
const SettingsStore = require('./settings');
const MqttBridge  = require('./mqtt-bridge');

const radioHandlers     = require('./handlers/radio');
const deviceHandlers    = require('./handlers/device');
const volumeHandlers    = require('./handlers/volume');
const systemHandlers    = require('./handlers/system');
const livetvHandlers    = require('./handlers/livetv');
const sourceHandlers    = require('./handlers/source');
const transportHandlers = require('./handlers/transport');
const youtubeHandlers    = require('./handlers/youtube');
const headwatersHandlers = require('./handlers/headwaters');
const navHandlers        = require('./handlers/nav');
const radioService      = require('./services/radio');
const volumeService     = require('./services/volume');
const guiService        = require('./services/gui');
const livetvService     = require('./services/livetv');
const playerService     = require('./services/player');
const youtubeSource     = require('./sources/youtube');
const CanBridge         = require('./can/bridge');
const MdnsAdvertiser    = require('./onboarding/mdns');
const ClaimServer       = require('./onboarding/claim-server');

const {
  CONFIG_DIR, SETTINGS_FILE, CONNECTION_FILE, CA_CERT_FILE,
} = require('./paths');

const settingsSchema   = require('./schema/settings.schema.json');
const connectionSchema = require('./schema/connection.schema.json');

// Read the controller's own version from package.json — useful in presence.
const PKG = require('../package.json');

// ──────────────────────────────────────────────────────────────────────
// First-run helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Generate a stable device id from the system hostname. The id is a
 * lowercase slug, capped at 32 chars, with non-alphanumeric chars folded
 * to dashes. Reserved value 'all' is escaped.
 */
function defaultDeviceId() {
  let h = os.hostname().toLowerCase();
  h = h.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!h) h = 'playbill';
  if (h === 'all') h = 'playbill-all';   // 'all' is the broadcast slug; can't be a device id
  return h.slice(0, 32);
}

function seedDefaultSettings() {
  return {
    device:   { id: defaultDeviceId(), name: 'Playbill' },
    display:  { theme: 'auto', idleTimeoutSeconds: 0 },
    behavior: { resumeLastSessionOnLaunch: true },
    hardware: { dvbAdapterIndex: null, rtlSdrAdapterIndex: null },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Bring up the spine
// ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  // Settings — required to be present (we seed defaults if missing).
  const settings = new SettingsStore({
    filePath: SETTINGS_FILE,
    schema:   settingsSchema,
    defaults: seedDefaultSettings(),
    required: false,
  });
  await settings.load();
  if (!fs.existsSync(SETTINGS_FILE)) {
    // First run — write defaults so the GUI has a stable file to edit.
    await settings.replace(seedDefaultSettings());
  }

  // Connection — *required* in the sense that without it the controller is
  // unconfigured. Load returns null if the file doesn't exist; that's fine.
  const connection = new SettingsStore({
    filePath: CONNECTION_FILE,
    schema:   connectionSchema,
    required: true,
  });
  await connection.load();

  const settingsView   = settings.get();
  const connectionView = connection.get();

  const state = new StateStore({
    device: {
      id:       settingsView.device.id,
      name:     settingsView.device.name,
      hostname: os.hostname(),
      version:  PKG.version,
      uptimeSec: 0,
    },
    connection: {
      // 'unconfigured' = no connection.json yet. 'configured' = file present;
      // actual connect status will become 'connecting' / 'connected' / 'error'
      // once Phase 1b wires in MQTT.
      status:    connectionView ? 'configured' : 'unconfigured',
      brokerUrl: connectionView ? connectionView.brokerUrl : null,
      lastError: null,
    },
    settings: settingsView,
    nowPlaying: null,
    source: null,
    radio: null,
    livetv: null,
    audio: null,        // populated below by volumeService.getState() probe
    gui:   { running: false, openedAt: null, closedAt: null },
    youtube: null,      // populated by youtubeHandlers.register's initial refreshState
    headwaters: null,   // populated by headwatersHandlers.register's initial load
    ui: null,
  });

  // Probe the system sink so state.audio is non-null at the moment the IPC
  // socket opens — observers subscribing on connect get a real snapshot
  // instead of having to wait for the first volume.* command. wpctl is
  // best-effort: if it's missing or the sink isn't ready, leave audio:null.
  try {
    state.patch({ audio: await volumeService.getState() });
  } catch (e) {
    console.warn('[playbill-controller] audio probe failed:', e.message);
  }

  const bus = new CommandBus();

  // MQTT bridge — created up front so handlers can ask it to reconfigure
  // when the user writes new credentials. The bridge does nothing if
  // connection.json is missing.
  const mqtt = new MqttBridge({
    commandBus: bus,
    stateStore: state,
    getConnection: () => connection.get(),
    getDeviceId:   () => state.get().device.id,
    getDeviceName: () => state.get().device.name,
    getVersion:    () => PKG.version,
  });

  registerSystemHandlers({ bus, state, settings, connection, mqtt });
  radioHandlers.register({ bus, state });
  volumeHandlers.register({ bus, state });
  livetvHandlers.register({ bus, state });
  deviceHandlers.register({ bus, state, settings });
  transportHandlers.register({ bus, state });
  sourceHandlers.register({ bus, state, sources: [youtubeSource] });
  youtubeHandlers.register({ bus, state });
  headwatersHandlers.register({ bus, state });
  // systemHandlers wants `ipc` so system.focus can publish a focus-request
  // event to the Electron main process — registered after ipc is created
  // (below) alongside navHandlers.

  // Probe whether the GUI is already running (e.g., user launched from GNOME
  // dock before the controller started). Without this, state.gui.running
  // stays false until the next first-client event, which is misleading.
  try {
    if (await guiService.isRunning()) {
      state.patch({ gui: { running: true, openedAt: Date.now(), closedAt: null } });
    }
  } catch (_) { /* best-effort */ }

  const ipc = new IpcServer({ commandBus: bus, stateStore: state });
  // GUI presence tracking — IPC client connect = GUI is up; last disconnect
  // = GUI quit. The state-store fan-out then publishes the change on
  // local/playbill/<id>/system/status so PWAs see GUI lifecycle live.
  ipc.on('first-client', () => {
    state.patch({ gui: { running: true, openedAt: Date.now(), closedAt: null } });
  });
  ipc.on('last-client-gone', () => {
    state.patch({ gui: { running: false, openedAt: null, closedAt: Date.now() } });
  });

  // nav.dpad + system.focus need the IPC server reference so they can fan
  // events out to the connected Electron GUI. Registered after ipc is
  // created but before start() so any command landing before the first
  // GUI connects still hits the bus (and no-ops on the fan-out).
  navHandlers.register({ bus, state, ipc });
  systemHandlers.register({ bus, ipc });

  const sockPath = await ipc.start();

  // Bring the MQTT bridge up. If unconfigured this is a no-op; once the
  // user enters credentials via the GUI, the connection.set handler calls
  // mqtt.reconfigure() to bring it up.
  await mqtt.start();

  // ─── Onboarding (mDNS + claim server) ──────────────────────────────
  // Per docs/app/onboarding.md: while unconfigured, advertise
  // _trailcurrent._tcp on the LAN AND listen for POST /discovery/claim
  // from the Headwaters host-side mDNS proxy. Once claimed, stop both so
  // future PWA scans don't re-list this Playbill.
  const mdns = new MdnsAdvertiser({
    getDeviceInfo: () => {
      const s = state.get();
      return {
        name:        s.device && s.device.name,
        deviceId:    s.device && s.device.id,
        canInstance: s.settings && s.settings.device && s.settings.device.canInstance,
        fw:          s.device && s.device.version,
      };
    },
  });
  const claim = new ClaimServer({
    connection,
    mqtt,
    settings,                                 // for optional deviceName in the claim payload
    isClaimed: () => connection.isPresent(),
    stateStore: state,
    onClaimed: () => {
      console.log('[onboarding] claim received — stopping mDNS + claim server');
      mdns.stop().catch(() => {});
      claim.stop().catch(() => {});
    },
  });
  function syncOnboardingToConnection() {
    if (connection.isPresent()) {
      // Configured — both should be off.
      if (mdns.isRunning())  mdns.stop().catch(() => {});
      if (claim._server)     claim.stop().catch(() => {});
    } else {
      // Unconfigured — advertise + listen.
      mdns.start();
      claim.start();
    }
  }
  syncOnboardingToConnection();
  state.subscribe(({ patch }) => {
    if (patch.connection) syncOnboardingToConnection();
  });

  // Fan state.* changes that map to MQTT status topics out to the broker.
  // Throttle position updates so we don't publish 30 times a second during
  // playback — once a second is plenty for remote UI.
  installStateToMqttFanout({ state, mqtt });

  // CAN bridge — only does anything when settings.device.canInstance is set
  // (0/1/2). MQTT-only Playbills (canInstance == null) opt out entirely.
  // Restart on canInstance changes so a user toggling the setting in the
  // GUI picks up the new block without a daemon restart.
  const canBridge = new CanBridge({
    mqtt,
    commandBus: bus,
    stateStore: state,
    getCanInstance: () => {
      const s = settings.get();
      return s && s.device ? (s.device.canInstance != null ? s.device.canInstance : null) : null;
    },
  });
  canBridge.start();
  let lastCanInstance = canBridge.getInstance();
  state.subscribe(({ patch, state: cur }) => {
    if (!patch.settings) return;
    const next = (cur.settings && cur.settings.device) ? (cur.settings.device.canInstance ?? null) : null;
    if (next === lastCanInstance) return;
    console.log(`[playbill-controller] device.canInstance changed (${lastCanInstance} → ${next}); restarting CAN bridge`);
    lastCanInstance = next;
    canBridge.start();
  });

  // Uptime ticker — bumps state.device.uptimeSec once a second so anyone
  // watching state can show "online for 4m 32s." Cheap; one tick a second.
  const t0 = Date.now();
  const uptimeTimer = setInterval(() => {
    const cur = state.get();
    state.patch({ device: { ...cur.device, uptimeSec: Math.round((Date.now() - t0) / 1000) } });
  }, 1000);
  uptimeTimer.unref();   // don't keep the event loop alive on its own

  console.log(`[playbill-controller] started`);
  console.log(`[playbill-controller]   device id:   ${state.get().device.id}`);
  console.log(`[playbill-controller]   device name: ${state.get().device.name}`);
  console.log(`[playbill-controller]   ipc socket:  ${sockPath}`);
  console.log(`[playbill-controller]   connection:  ${state.get().connection.status}`);
  if (state.get().connection.status === 'unconfigured') {
    console.log(`[playbill-controller]   awaiting configuration via GUI Settings → Connection`);
  }

  // ── Graceful shutdown ────────────────────────────────────────────
  const shutdown = async (sig) => {
    console.log(`[playbill-controller] ${sig} received, shutting down`);
    clearInterval(uptimeTimer);
    try { canBridge.stop(); } catch (e) { console.error('[shutdown] can:', e); }
    try { await radioService.stop(); } catch (e) { console.error('[shutdown] radio:', e); }
    try { await livetvService.stopAll(); } catch (e) { console.error('[shutdown] livetv:', e); }
    try { await playerService.stop(); } catch (e) { console.error('[shutdown] player:', e); }
    try { await mdns.stop(); }   catch (e) { console.error('[shutdown] mdns:', e); }
    try { await claim.stop(); }  catch (e) { console.error('[shutdown] claim:', e); }
    try { await mqtt.stop(); } catch (e) { console.error('[shutdown] mqtt:', e); }
    try { await ipc.stop(); }  catch (e) { console.error('[shutdown] ipc:', e); }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// ──────────────────────────────────────────────────────────────────────
// State → MQTT fan-out
// ──────────────────────────────────────────────────────────────────────
//
// Subscribe to state changes and publish them on the matching status
// topics. Each state category maps to one feature topic. Position updates
// are throttled to once per second per feature.

function installStateToMqttFanout({ state, mqtt }) {
  // Only `transport` carries a real high-frequency stream (mpv emits position
  // ~30Hz). Everything else (radio band/freq, livetv channel, system presence)
  // is event-driven and should publish on every change so observers see the
  // user's last action retained on the broker without waiting out a window.
  const THROTTLED_FEATURES = new Set(['transport']);
  const THROTTLE_MS = 1000;
  const lastSentAt = new Map();

  function publish(feature, payload) {
    if (THROTTLED_FEATURES.has(feature)) {
      const now = Date.now();
      const last = lastSentAt.get(feature) || 0;
      if (now - last < THROTTLE_MS) return;
      lastSentAt.set(feature, now);
    }
    mqtt.publishStatus(feature, payload, { retain: true, qos: 1 });
  }

  // Single source of truth for what each feature topic carries. Called both
  // by the state.subscribe diff path (only fires for changed slices) and by
  // the mqtt.onConnect snapshot path (republishes everything that has a
  // non-null current value).
  function publishFeature(feature, cur) {
    switch (feature) {
      case 'system':
        publish('system', {
          online: true,
          guiOpen: !!(cur.gui && cur.gui.running),
          currentScreen: cur.ui && cur.ui.screen,
          name: cur.device.name,
          hostname: cur.device.hostname,
          version: cur.device.version,
          uptimeSec: cur.device.uptimeSec,
          ts: Date.now(),
        });
        break;
      case 'transport': publish('transport', cur.nowPlaying || { paused: true }); break;
      case 'radio':     publish('radio',     cur.radio  || null); break;
      case 'livetv':    publish('livetv',    cur.livetv || null); break;
      case 'volume':    publish('volume',    cur.audio  || null); break;
      // 'source' carries the current "mode" — which thing on the device is
      // active right now (radio | livetv | youtube | plex | ... | null).
      // Other clients (PWA, Milepost, future CAN listener) consume this so
      // their UI shows the right view when a different device flips modes.
      case 'source':    publish('source',    { source: cur.source || null, ts: Date.now() }); break;
    }
  }

  state.subscribe(({ patch, state: cur }) => {
    // Presence updates whenever device id/name/version moves OR the GUI
    // launches/quits. Authoritative `guiOpen` from state.gui — driven by
    // the IPC server's first-/last-client events.
    if (patch.device || patch.connection || patch.gui) publishFeature('system', cur);
    if (patch.nowPlaying !== undefined) publishFeature('transport', cur);
    if (patch.radio !== undefined)      publishFeature('radio',     cur);
    if (patch.livetv !== undefined)     publishFeature('livetv',    cur);
    if (patch.audio !== undefined)      publishFeature('volume',    cur);
    // patch.source uses `in patch` rather than !== undefined because we
    // explicitly set source:null on stop and that needs to publish too.
    if ('source' in patch)              publishFeature('source',    cur);
  });

  // Republish every feature whenever the broker (re)connects. Handles two
  // races: (1) state mutated before this subscribe ran — e.g. the audio
  // probe at startup; (2) state mutated while the broker was disconnected.
  // Without this, those values never reach the broker.
  if (typeof mqtt.onConnect === 'function') {
    mqtt.onConnect(() => {
      const cur = state.get();
      publishFeature('system', cur);
      if (cur.nowPlaying !== undefined) publishFeature('transport', cur);
      if (cur.radio      !== undefined) publishFeature('radio',     cur);
      if (cur.livetv     !== undefined) publishFeature('livetv',    cur);
      if (cur.audio      !== undefined) publishFeature('volume',    cur);
      publishFeature('source', cur);   // always; null is a meaningful value
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// System command handlers (the only handlers needed before MQTT is up)
// ──────────────────────────────────────────────────────────────────────

function registerSystemHandlers({ bus, state, settings, connection, mqtt }) {
  // settings.get — return a snapshot of validated settings
  bus.register('settings.get', async () => settings.get());

  // settings.replace — wholesale replace, for the Settings UI's Save button
  bus.register('settings.replace', async (cmd) => {
    if (!cmd.value || typeof cmd.value !== 'object') {
      throw new Error('settings.replace: value must be an object');
    }
    await settings.replace(cmd.value);
    const next = settings.get();
    state.patch({
      settings: next,
      device: { ...state.get().device, id: next.device.id, name: next.device.name },
    });
    return { ok: true };
  });

  // settings.patch — shallow merge a partial update. The common case from
  // the GUI's per-setting controls.
  bus.register('settings.patch', async (cmd) => {
    if (!cmd.value || typeof cmd.value !== 'object') {
      throw new Error('settings.patch: value must be an object');
    }
    await settings.patch(cmd.value);
    const next = settings.get();
    state.patch({
      settings: next,
      device: { ...state.get().device, id: next.device.id, name: next.device.name },
    });
    return { ok: true };
  });

  // connection.get — current MQTT connection config (without the password)
  bus.register('connection.get', async () => {
    const c = connection.get();
    if (!c) return null;
    // Never return the password over IPC. The GUI doesn't need to display
    // it; if the user wants to change it they re-enter.
    const { password: _drop, ...safe } = c;
    return safe;
  });

  // connection.set — write or replace the MQTT connection config. Same
  // brokerUrl normalization as the claim-server (hostname-only accepted,
  // mqtt:// upgraded to mqtts://, default port 8883). Persisted form is
  // always strict `mqtts://host:port`.
  bus.register('connection.set', async (cmd) => {
    if (!cmd.value || typeof cmd.value !== 'object') {
      throw new Error('connection.set: value must be an object');
    }
    const v = { ...cmd.value };
    if (v.brokerUrl !== undefined) {
      const { normalizeBrokerUrl } = require('./mqtt-bridge');
      v.brokerUrl = normalizeBrokerUrl(v.brokerUrl);
    }
    await connection.replace(v);
    state.patch({
      connection: { status: 'configured', brokerUrl: connection.get().brokerUrl, lastError: null },
    });
    // Bring the bridge up (or swap creds if it was already up).
    if (mqtt) {
      mqtt.reconfigure().catch((e) => {
        console.error('[connection.set] mqtt reconfigure failed:', e);
        state.patch({ connection: { status: 'error', brokerUrl: connection.get().brokerUrl, lastError: e.message } });
      });
    }
    return { ok: true };
  });

  // connection.clear — wipe credentials (Settings → Headwaters "Forget" button).
  // We DON'T touch the OS trust store here — that requires sudo, which a
  // user-session daemon shouldn't do silently. The UI surfaces a copyable
  // command the user can run in a terminal to remove the cert system-wide.
  bus.register('connection.clear', async () => {
    await connection.clear();
    try { fs.unlinkSync(CA_CERT_FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    state.patch({ connection: { status: 'unconfigured', brokerUrl: null, lastError: null } });
    if (mqtt) await mqtt.stop();
    return { ok: true };
  });

  // connection.setCa — persist the pasted CA cert to the user-config dir
  // (mode 0600). The Settings UI then shows the user a copyable command
  // they can run in a terminal to install this cert into the OS trust
  // store (/usr/local/share/ca-certificates/trailcurrent.crt + update-ca-
  // certificates). Doing the install via sudo from the daemon was the
  // first design, then rejected — making cert installation explicit and
  // user-driven is auditable and avoids a privileged action surface.
  bus.register('connection.setCa', async (cmd) => {
    if (typeof cmd.value !== 'string' || !cmd.value.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('connection.setCa: value must be a PEM-encoded certificate');
    }
    fs.writeFileSync(CA_CERT_FILE, cmd.value, { mode: 0o600 });
    const cur = connection.get() || {};
    if (cur.brokerUrl && cur.username && cur.password) {
      await connection.replace({ ...cur, caCertProvided: true });
    }
    return { ok: true, caPath: CA_CERT_FILE };
  });

  // system.commands — introspection: list every registered action
  bus.register('system.commands', async () => bus.listActions());

  // system.echo — sanity-check round-trip for the IPC channel
  bus.register('system.echo', async (cmd) => ({ echo: cmd.value }));
}

main().catch((e) => {
  console.error('[playbill-controller] fatal:', e);
  process.exit(1);
});
