/* YouTube OAuth — built-in (default) client credentials.
 *
 * Real credential values live in `default-client.local.js` (gitignored,
 * generated at build time from <repo>/.env by
 * build-tools/embed-yt-credentials.js). This wrapper exposes that file
 * if it exists, or null if the build skipped the embed step.
 *
 * `client_secret` for an OAuth client of type "TVs and Limited Input devices"
 * is not actually secret — Google's own docs acknowledge that distributed
 * device apps cannot keep secrets — but we still treat the value as private
 * by keeping it out of the repo, out of the IPC surface, and out of any
 * UI element. The controller is the only process that ever sees it. */

'use strict';

let baked = null;
try { baked = require('./default-client.local'); } catch (_) { /* not built */ }

function getDefaultClient() {
  if (!baked || !baked.clientId || !baked.clientSecret) return null;
  return { clientId: baked.clientId, clientSecret: baked.clientSecret };
}

function hasDefaultClient() {
  return !!getDefaultClient();
}

module.exports = { getDefaultClient, hasDefaultClient };
