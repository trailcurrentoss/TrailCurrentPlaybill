/* On-disk paths Playbill uses for runtime state.
   ~/.config/trailcurrent-playbill/        config (presets, channel scans)
   /tmp/playbill-runtime/                  ephemeral capture buffers, IPC sockets */

const os = require('os');
const path = require('path');
const fs = require('fs');

const CONFIG_DIR  = path.join(os.homedir(), '.config', 'trailcurrent-playbill');
const RUNTIME_DIR = path.join(os.tmpdir(), 'playbill-runtime');

function ensureDirs() {
  fs.mkdirSync(CONFIG_DIR,  { recursive: true });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

module.exports = {
  CONFIG_DIR,
  RUNTIME_DIR,
  CHANNELS_CONF: path.join(CONFIG_DIR, 'channels.conf'),
  PRESETS_JSON:  path.join(CONFIG_DIR, 'radio-presets.json'),
  ensureDirs,
};
