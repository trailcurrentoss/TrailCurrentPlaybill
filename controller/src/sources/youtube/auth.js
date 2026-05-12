/* YouTube OAuth — Google's "TV / Limited Input Devices" device flow.

   The user creates an OAuth client of type "TVs and Limited Input devices"
   in their own Google Cloud Console, drops the resulting clientId +
   clientSecret into Settings → YouTube on Playbill, and runs the sign-in
   from there. That client doesn't need a publishing review for read-only
   YouTube scope; same model the Kodi YouTube addon uses (and asks every
   user to create their own client for, since Google periodically revokes
   shared community credentials).

   Flow per https://developers.google.com/identity/protocols/oauth2/limited-input-device:

     1. start()   POST oauth2.googleapis.com/device/code
                  → { device_code, user_code, verification_url, expires_in, interval }
                  Show user_code + verification_url to the user; they enter it on
                  https://www.google.com/device from a phone/laptop.

     2. poll()    POST oauth2.googleapis.com/token (grant_type device-code)
                  → 'authorization_pending' until the user completes,
                    then { access_token, refresh_token, expires_in, ... }

     3. After tokens land: persist at sources/youtube/tokens.json (mode 0600).

     4. getAccessToken() — return the current access_token; refresh if
        within 60 s of expiry. Refresh uses { grant_type: 'refresh_token' }.

   Tokens lifetime: access_token ~1h, refresh_token long-lived (until the
   user revokes from their Google account dashboard).

   We never log token values. Errors get the response code + Google's
   `error` / `error_description` body fields, which are non-secret. */

'use strict';

const fs = require('fs');
const { promises: fsp } = fs;

const SettingsStore = require('../../settings');
const {
  sourceSettings, sourceTokens, sourceDir,
} = require('../../paths');
const defaultClient = require('./default-client');

const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL       = 'https://oauth2.googleapis.com/token';
const REVOKE_URL      = 'https://oauth2.googleapis.com/revoke';
const SCOPE           = 'https://www.googleapis.com/auth/youtube.readonly';
const DEVICE_GRANT    = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_LEAD_S  = 60;   // refresh tokens this many seconds before expiry

// ── Per-source settings schema (clientId + clientSecret) ──────────────

const settingsSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id:     'trailcurrent-playbill-source-youtube',
  type:    'object',
  additionalProperties: false,
  properties: {
    clientId:     { type: 'string' },
    clientSecret: { type: 'string' },
  },
};

const tokensSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id:     'trailcurrent-playbill-source-youtube-tokens',
  type:    'object',
  additionalProperties: true,         // forward-compat with future Google fields
  required: ['access_token', 'refresh_token', 'expires_at'],
  properties: {
    access_token:  { type: 'string' },
    refresh_token: { type: 'string' },
    token_type:    { type: 'string' },
    expires_at:    { type: 'integer' },   // ms since epoch when access_token dies
    scope:         { type: 'string' },
  },
};

// ── State ─────────────────────────────────────────────────────────────

let credsStore  = null;   // SettingsStore for sources/youtube/settings.json
let tokenStore  = null;   // SettingsStore for sources/youtube/tokens.json
let pending     = null;   // { device_code, user_code, verification_url, expires_at, interval, pollHandle }

async function _ensureStores() {
  if (credsStore && tokenStore) return;
  fs.mkdirSync(sourceDir('youtube'), { recursive: true, mode: 0o700 });
  if (!credsStore) {
    credsStore = new SettingsStore({
      filePath: sourceSettings('youtube'),
      schema:   settingsSchema,
      defaults: {},
      required: false,
    });
    await credsStore.load();
  }
  if (!tokenStore) {
    tokenStore = new SettingsStore({
      filePath: sourceTokens('youtube'),
      schema:   tokensSchema,
      required: true,
    });
    await tokenStore.load();
  }
}

function _creds() {
  // Per-user override wins (kept for admin tooling), then fall back to the
  // OAuth client baked into the build at <repo>/.env time. Renderer never
  // sees either set of values.
  const c = credsStore && credsStore.get();
  if (c && c.clientId && c.clientSecret) return c;
  const d = defaultClient.getDefaultClient();
  if (d) return d;
  throw new Error('YouTube OAuth not configured: the build is missing default-client.local.js (run `npm run embed-creds` with a valid .env)');
}

// ── Device flow ───────────────────────────────────────────────────────

/**
 * Start the device flow. Returns the user-facing code + URL for display.
 * Does NOT block; call poll() to drive completion.
 */
async function start() {
  await _ensureStores();
  const { clientId } = _creds();

  const body = new URLSearchParams({ client_id: clientId, scope: SCOPE }).toString();
  const r = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(`device/code ${r.status}: ${j.error || ''} ${j.error_description || ''}`.trim());
  }

  const expires_at = Date.now() + (j.expires_in || 1800) * 1000;
  // Google returns `https://www.google.com/device`, but the YouTube-branded
  // `https://www.youtube.com/activate` page accepts the same code and is the
  // URL consumer TVs use. Override here so the on-screen text matches what
  // users expect from Roku/Apple TV/etc.
  pending = {
    device_code:      j.device_code,
    user_code:        j.user_code,
    verification_url: 'https://www.youtube.com/activate',
    expires_at,
    interval:         (j.interval || 5) * 1000,
  };
  return {
    user_code:        pending.user_code,
    verification_url: pending.verification_url,
    expires_at,
  };
}

/**
 * Poll the token endpoint once. Returns:
 *   { status: 'pending' }                 — keep polling
 *   { status: 'success', accountName? }   — tokens persisted
 *   { status: 'expired' }                 — code timed out, restart
 *   { status: 'denied' }                  — user declined
 *   { status: 'error', error, message }   — Google returned something we didn't expect
 */
async function poll() {
  if (!pending) throw new Error('poll(): no pending sign-in — call start() first');
  if (Date.now() > pending.expires_at) { pending = null; return { status: 'expired' }; }

  const { clientId, clientSecret } = _creds();
  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    device_code:   pending.device_code,
    grant_type:    DEVICE_GRANT,
  }).toString();

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();

  if (r.status === 200 && j.access_token) {
    const expires_at = Date.now() + (j.expires_in || 3600) * 1000;
    await tokenStore.replace({
      access_token:  j.access_token,
      refresh_token: j.refresh_token,
      token_type:    j.token_type || 'Bearer',
      scope:         j.scope || SCOPE,
      expires_at,
    });
    pending = null;
    return { status: 'success' };
  }

  // Google returns 4xx with error codes during the wait.
  switch (j.error) {
    case 'authorization_pending': return { status: 'pending' };
    case 'slow_down':              pending.interval += 1000; return { status: 'pending' };
    case 'expired_token':          pending = null; return { status: 'expired' };
    case 'access_denied':          pending = null; return { status: 'denied' };
    default:
      return { status: 'error', error: j.error || ('http_' + r.status), message: j.error_description || '' };
  }
}

function pendingState() {
  if (!pending) return null;
  return {
    user_code:        pending.user_code,
    verification_url: pending.verification_url,
    expires_at:       pending.expires_at,
    interval:         pending.interval,
  };
}

function cancel() {
  pending = null;
}

// ── Token management (refresh + retrieve) ─────────────────────────────

/**
 * Return a usable access_token. Refreshes if within REFRESH_LEAD_S of
 * expiry. Returns null if not signed in.
 */
async function getAccessToken() {
  await _ensureStores();
  let t = tokenStore.get();
  if (!t) return null;

  const ms = t.expires_at - Date.now();
  if (ms > REFRESH_LEAD_S * 1000) return t.access_token;

  // Refresh.
  const { clientId, clientSecret } = _creds();
  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: t.refresh_token,
    grant_type:    'refresh_token',
  }).toString();
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error(`refresh failed ${r.status}: ${j.error || ''} ${j.error_description || ''}`.trim());
  }
  const expires_at = Date.now() + (j.expires_in || 3600) * 1000;
  await tokenStore.replace({
    access_token:  j.access_token,
    refresh_token: j.refresh_token || t.refresh_token,   // sometimes Google omits it
    token_type:    j.token_type || t.token_type || 'Bearer',
    scope:         j.scope || t.scope,
    expires_at,
  });
  return j.access_token;
}

function isSignedIn() { return !!(tokenStore && tokenStore.get()); }

async function signOut() {
  await _ensureStores();
  const t = tokenStore.get();
  if (t && t.refresh_token) {
    // Revoke best-effort. We always wipe the local file even if the
    // network call fails, because the user expects "Sign Out" to work
    // even offline.
    try {
      const body = new URLSearchParams({ token: t.refresh_token }).toString();
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (_) { /* best-effort */ }
  }
  await tokenStore.clear();
  return { ok: true };
}

// ── Settings management (clientId / clientSecret) ─────────────────────

async function getSettings() {
  await _ensureStores();
  const c = credsStore.get() || {};
  const haveDefault = defaultClient.hasDefaultClient();
  // Never return any clientId / clientSecret value over IPC. The renderer
  // only needs to know whether sign-in is wired (haveDefault || user creds)
  // so it can decide whether to enable the Sign In button.
  return {
    clientIdSet:     !!c.clientId,
    clientSecretSet: !!c.clientSecret,
    defaultClient:   haveDefault,
    canSignIn:       haveDefault || (!!c.clientId && !!c.clientSecret),
  };
}

async function setSettings({ clientId, clientSecret }) {
  await _ensureStores();
  if (clientId === undefined && clientSecret === undefined) {
    throw new Error('setSettings: provide clientId and/or clientSecret');
  }
  const cur = credsStore.get() || {};
  const next = { ...cur };
  if (clientId !== undefined) {
    if (typeof clientId !== 'string' || !clientId.length) throw new Error('clientId must be a non-empty string');
    next.clientId = clientId;
  }
  if (clientSecret !== undefined) {
    if (typeof clientSecret !== 'string' || !clientSecret.length) throw new Error('clientSecret must be a non-empty string');
    next.clientSecret = clientSecret;
  }
  await credsStore.replace(next);
  return { ok: true };
}

module.exports = {
  start, poll, pendingState, cancel,
  getAccessToken, isSignedIn, signOut,
  getSettings, setSettings,
  SCOPE,
};
