/* Headwaters HTTP API base — single source of truth for the hostname all
   controller modules use when calling Headwaters.

   The rig's API host is always the same physical machine as the MQTT
   broker (one Headwaters per rig serves both). We therefore derive the
   API hostname from `state.connection.brokerUrl` so a hostname change in
   one place automatically retargets every API caller — there's no
   second config field to drift out of sync.

   When the connection is unconfigured (first run, before the user has
   pasted creds) `brokerUrl` is null; in that case we fall back to the
   canonical 'headwaters.local' so probes still go somewhere sensible.

   Every Headwaters API call in the controller MUST go through `apiUrl`
   so a single audit of this file shows where requests land. */

'use strict';

const DEFAULT_HOST = 'headwaters.local';

function host(state) {
  try {
    const broker = state && state.get && state.get().connection && state.get().connection.brokerUrl;
    if (broker) return new URL(broker).hostname;
  } catch (_) { /* fall through to default */ }
  return DEFAULT_HOST;
}

/**
 * Build a full Headwaters API URL. Always https; the path argument is
 * always joined under that hostname so callers can't accidentally hit a
 * different host by passing an absolute URL.
 *
 *   apiUrl(state, '/api/modules/types') → 'https://headwaters.local/api/modules/types'
 *   apiUrl(state, 'api/health')         → 'https://headwaters.local/api/health'
 */
function apiUrl(state, pathOrUri) {
  const h = host(state);
  const p = (typeof pathOrUri === 'string') ? pathOrUri : '';
  const path = p.startsWith('/') ? p : '/' + p;
  return `https://${h}${path}`;
}

module.exports = { host, apiUrl, DEFAULT_HOST };
