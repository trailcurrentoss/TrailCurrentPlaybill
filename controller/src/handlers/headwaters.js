/* headwaters.* command handlers — store the API key the controller will
   send when calling the Headwaters HTTP APIs.

   The key is a secret, so it lives in its own file (headwaters.json,
   mode 0600) and is never returned over IPC — `headwaters.getSettings`
   only reports an existence flag. */

'use strict';

const SettingsStore = require('../settings');
const { HEADWATERS_FILE } = require('../paths');
const schema = require('../schema/headwaters.schema.json');

let store = null;

async function ensureStore() {
  if (store) return store;
  store = new SettingsStore({
    filePath: HEADWATERS_FILE,
    schema,
    required: true,
  });
  await store.load();
  return store;
}

function register({ bus, state }) {
  // Initialize state.headwaters so subscribers see a real snapshot.
  ensureStore()
    .then(() => state.patch({ headwaters: { apiKeySet: !!(store.get() && store.get().apiKey) } }))
    .catch((e) => console.warn('[headwaters] initial state refresh failed:', e.message));

  bus.register('headwaters.getSettings', async () => {
    const s = await ensureStore();
    const cur = s.get() || {};
    // Never return the key value over IPC — only existence.
    return { apiKeySet: !!cur.apiKey };
  });

  bus.register('headwaters.setSettings', async (cmd) => {
    const v = cmd.value || {};
    if (typeof v.apiKey !== 'string' || !v.apiKey.trim()) {
      throw new Error('headwaters.setSettings: apiKey must be a non-empty string');
    }
    const s = await ensureStore();
    await s.replace({ apiKey: v.apiKey.trim() });
    state.patch({ headwaters: { apiKeySet: true } });
    return { ok: true };
  });

  bus.register('headwaters.clear', async () => {
    const s = await ensureStore();
    await s.clear();
    state.patch({ headwaters: { apiKeySet: false } });
    return { ok: true };
  });
}

/** Read the current API key (for use by services making Headwaters calls). */
async function getApiKey() {
  const s = await ensureStore();
  const cur = s.get() || {};
  return cur.apiKey || null;
}

module.exports = { register, getApiKey };
