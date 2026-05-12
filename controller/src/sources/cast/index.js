/* Cast source plugin — AirPlay receiver via UxPlay.

   Unlike browse-style sources (YouTube, Plex), Cast has nothing to list
   or search. The user picks "Cast" in the apps grid and a phone pushes
   media at the device. The source-plugin shape still applies — capability
   set is just different — so the apps grid renders it like any other
   source and source.launch sets state.source = 'cast' the same way.

   Capabilities:
     'receive'   — accepts pushed media (this plugin)
     'browse'    — has a list() (this plugin does not)
     'search'    — has a search() (this plugin does not)

   The lifecycle (start/stop/getStatus) is handled by cast.* command
   handlers (handlers/cast.js), not by the generic source dispatcher. */

'use strict';

const id           = 'cast';
const displayName  = 'Cast from phone';
const icon         = 'phone-portrait-outline';
const capabilities = ['receive'];

module.exports = {
  id, displayName, icon, capabilities,
};
