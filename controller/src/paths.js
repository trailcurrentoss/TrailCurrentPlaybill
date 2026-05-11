/* On-disk and per-user paths the controller uses.
   Per-user, never system-wide — a user's MQTT credentials and OAuth tokens
   are theirs, not the rig's. Mirrors the existing app/main/services/paths.js
   layout so files written by Stage-1 Electron code are still readable here. */

'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();

// XDG_RUNTIME_DIR is the right home for non-persistent sockets — it's a
// tmpfs that systemd cleans up at logout. Fall back to /tmp/runtime-<uid>
// for non-systemd environments (e.g., a CI box without a session).
const RUNTIME_DIR =
  process.env.XDG_RUNTIME_DIR ||
  path.join('/tmp', 'runtime-' + (typeof process.getuid === 'function' ? process.getuid() : 0));

const CONFIG_DIR  = path.join(HOME, '.config', 'trailcurrent-playbill');
const SOURCES_DIR = path.join(CONFIG_DIR, 'sources');

const fs = require('fs');

function ensureDirs() {
  fs.mkdirSync(CONFIG_DIR,  { recursive: true, mode: 0o700 });
  fs.mkdirSync(SOURCES_DIR, { recursive: true, mode: 0o700 });
}

module.exports = {
  CONFIG_DIR,
  SOURCES_DIR,
  RUNTIME_DIR,

  // Connection settings (broker URL, username, password, hostname override).
  // Separated from settings.json because it contains a secret — easier to
  // grep for, easier to back up selectively, easier to nuke for re-pairing.
  CONNECTION_FILE: path.join(CONFIG_DIR, 'connection.json'),

  // CA cert pasted/uploaded by the user during first-run setup.
  CA_CERT_FILE: path.join(CONFIG_DIR, 'ca.pem'),

  // Headwaters API key — kept out of settings.json because it's a secret.
  HEADWATERS_FILE: path.join(CONFIG_DIR, 'headwaters.json'),

  // Everything else (theme, behavior toggles, defaults, last-used selections).
  SETTINGS_FILE: path.join(CONFIG_DIR, 'settings.json'),

  // Local IPC socket the GUI connects to. Owner-only, deleted on daemon exit.
  IPC_SOCKET: path.join(RUNTIME_DIR, 'playbill-controller.sock'),

  // Radio presets (FM/AM frequency slots + labels). Written by the Settings
  // UI; shared with the Electron app's legacy path so a user that already
  // saved presets via the old in-Electron handler keeps them.
  PRESETS_JSON: path.join(CONFIG_DIR, 'radio-presets.json'),

  // DVB channel scan output (Live TV — moves into the controller in Phase 5).
  CHANNELS_CONF: path.join(CONFIG_DIR, 'channels.conf'),

  // Per-source storage helper. Each source plugin writes settings + tokens
  // under sources/<sourceId>/ at file mode 0600. Builders rather than
  // constants because the source set is open-ended.
  sourceDir(sourceId)        { return path.join(SOURCES_DIR, sourceId); },
  sourceSettings(sourceId)   { return path.join(SOURCES_DIR, sourceId, 'settings.json'); },
  sourceTokens(sourceId)     { return path.join(SOURCES_DIR, sourceId, 'tokens.json'); },

  ensureDirs,
};
