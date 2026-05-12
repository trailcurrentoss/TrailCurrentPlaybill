/* Netflix source plugin — Netflix via Brave kiosk.

   Same shape as the Cast plugin: no list/search/resolve, just a descriptor
   the apps grid can render. Lifecycle (start/stop/getStatus) is owned by
   netflix.* command handlers (handlers/netflix.js).

   Netflix is DRM-locked (Widevine); we shell out to Brave with
   --kiosk --app=https://www.netflix.com instead of going through mpv.
   Google doesn't ship Chrome for ARM64 Linux, hence Brave. */

'use strict';

const id           = 'netflix';
const displayName  = 'Netflix';
const icon         = 'logo-netflix';
const capabilities = ['launch'];

module.exports = {
  id, displayName, icon, capabilities,
};
