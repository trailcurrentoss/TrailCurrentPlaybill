/* headwaters.* command handlers — store the API key the controller will
   send when calling the Headwaters HTTP APIs.

   The key is a secret, so it lives in its own file (headwaters.json,
   mode 0600) and is never returned over IPC — `headwaters.getSettings`
   only reports an existence flag. */

'use strict';

const https = require('https');
const fs = require('fs');
const SettingsStore = require('../settings');
const { HEADWATERS_FILE, CA_CERT_FILE } = require('../paths');
const headwatersApi = require('../services/headwaters-api');
const { classify } = require('../services/error-classify');
const schema = require('../schema/headwaters.schema.json');

// /api/modules/types is gated by the auth middleware AND reliably returns
// 200 with a small JSON body on every Headwaters build we've shipped. So
// the response code disambiguates cleanly:
//   200 = key valid (auth passed AND the route exists)
//   401 = bad/revoked key (auth middleware rejected)
//   other = something else wrong (surface verbatim)
// First-attempt picked /api/discovery — turned out it 404s even with a
// valid key on the live Headwaters, so we'd never see green. Don't repeat.
const VALIDATE_PATH = '/api/modules/types';
const VALIDATE_TIMEOUT_MS = 8000;

function validateKeyOverHttps(apiKey, state) {
  const url = headwatersApi.apiUrl(state, VALIDATE_PATH);
  const host = headwatersApi.host(state);
  return new Promise((resolve) => {
    const opts = {
      method: 'GET',
      headers: { 'Authorization': apiKey, 'Accept': 'application/json' },
      timeout: VALIDATE_TIMEOUT_MS,
    };
    // If the user has pasted a CA, use it — otherwise rely on the system
    // store. Either way TLS is mandatory.
    try {
      if (fs.existsSync(CA_CERT_FILE)) opts.ca = fs.readFileSync(CA_CERT_FILE);
    } catch (_) { /* fall back to system store */ }
    const req = https.request(url, opts, (res) => {
      res.resume();   // drain so the socket closes cleanly
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ ok: true, status: 200 });
        } else {
          const c = classify(new Error(`HTTP ${res.statusCode}`),
                             { host, protocol: 'http', statusCode: res.statusCode });
          resolve({ ok: false, kind: c.kind, status: res.statusCode, error: c.message });
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => {
      const c = classify(e, { host, protocol: 'http' });
      resolve({ ok: false, kind: c.kind, error: c.message });
    });
    req.end();
  });
}

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
    // Merge into existing file so sibling credentials (e.g. omdbApiKey
    // written by the DVD handler) survive a key rotation here.
    const cur = s.get() || {};
    await s.replace({ ...cur, apiKey: v.apiKey.trim() });
    state.patch({ headwaters: { apiKeySet: true } });
    return { ok: true };
  });

  bus.register('headwaters.clear', async () => {
    const s = await ensureStore();
    // Remove apiKey but keep other fields. If nothing is left, drop the
    // whole file — matches the "Forget credentials" intent without
    // collateral damage to omdbApiKey.
    const cur = s.get() || {};
    const { apiKey: _drop, ...rest } = cur;
    if (Object.keys(rest).length === 0) {
      await s.clear();
    } else {
      await s.replace(rest);
    }
    state.patch({ headwaters: { apiKeySet: false } });
    return { ok: true };
  });

  // headwaters.validateApiKey — verify a key works against the live
  // Headwaters API. Used by Settings → Headwaters after the user pastes
  // a key, so a typo or revoked key is caught at save time instead of
  // silently producing 401s on every later call. If `value.apiKey` is
  // present we validate THAT (pre-save check); otherwise we validate
  // whatever is currently stored.
  bus.register('headwaters.validateApiKey', async (cmd) => {
    let key = cmd && cmd.value && cmd.value.apiKey;
    if (typeof key !== 'string' || !key.trim()) {
      const s = await ensureStore();
      const cur = s.get() || {};
      key = cur.apiKey;
    }
    if (!key) return { ok: false, stage: 'missing', error: 'No API key to validate.' };
    return validateKeyOverHttps(key.trim(), state);
  });
}

/** Read the current API key (for use by services making Headwaters calls). */
async function getApiKey() {
  const s = await ensureStore();
  const cur = s.get() || {};
  return cur.apiKey || null;
}

// Re-export the API URL builder so anywhere that needs to construct a
// Headwaters URL imports it from one place.
const { apiUrl, host } = headwatersApi;

module.exports = { register, getApiKey, apiUrl, host };
