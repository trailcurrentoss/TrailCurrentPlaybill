/* YouTube OAuth — optional dev-only built-in client credentials.
 *
 * Shipped images carry NO default client. image/build.sh sets
 * PLAYBILL_IMAGE_BUILD=1 which forces build-tools/embed-yt-credentials.js
 * to emit `module.exports = null` here. End-users follow
 * docs/youtube-setup.md (mirrored in the Headwaters PWA at
 * /docs/playbill-youtube-setup.html) to create their own Google Cloud
 * OAuth client, then paste it via the PWA's Playbill → YouTube tab.
 * Their values land per-rig at
 * ~/.config/trailcurrent-playbill/sources/youtube/client.json (mode 0600)
 * and never leave the device.
 *
 * Why ship empty: a baked-in client means every end-user's API calls
 * burn the developer's YouTube Data API quota and re-consents pile up
 * against one Google Cloud project — and the only fix once distributed
 * is to rotate the secret, which breaks every existing install.
 *
 * The default-client.local.js file exists only as a dev convenience: on
 * the developer's own machine, running `npm run build:creds` (without
 * PLAYBILL_IMAGE_BUILD=1) bakes their .env values here so their personal
 * Playbill works without going through the PWA setup. NEVER ship a deb
 * produced this way. */

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
