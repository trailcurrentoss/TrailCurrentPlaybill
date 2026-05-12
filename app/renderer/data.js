/* Stage 1 placeholder data — full TV shell rendered with empty content arrays.
   Live TV channels and radio presets are loaded from the main process at
   runtime (see live.jsx and radio.jsx); the rest of these arrays land in a
   later stage when Headwaters NAS / external app integrations come online. */

const TV_DATA = {
  featured: {
    title: "TrailCurrent Playbill",
    tag: "Stage 1 · Empty Shell",
    meta: ["No content yet", "Wire in Stage 2"],
    rating: "—",
    desc: "Headwaters media library, vehicle telemetry, exterior cameras, and external streaming apps wire up in later stages. Live TV and Radio are wired to real hardware (Hauppauge WinTV-dualHD + RTL-SDR) via the main-process services.",
    bg: null,
  },

  continue:  [],

  // Streaming-service launchers. Each entry's `launch` field names a handler
  // registered in TV_APPS.launch below; that handler calls into the main
  // process via the preload bridge.
  apps: [
    {
      id: 'youtube',
      label: 'YouTube',
      icon: 'logo-youtube',
      bg: '#FF0000',
      launch: 'youtube',
    },
    {
      id: 'cast',
      label: 'Cast',
      icon: 'phone-portrait-outline',
      bg: 'linear-gradient(135deg, #5a8a4a, #2b4a23)',
      launch: 'cast',
    },
  ],

  rowTrails: [],
  movies:    [],
  music:     [],

  // Camera tile labels stay — they're static UI scaffolding for the Rig screen,
  // not media. The actual feeds wire up in Stage 2.
  cams: [
    { id: 'cam1', label: "FRONT",     title: "Front · 4K"     },
    { id: 'cam2', label: "REAR",      title: "Rear · 1080p"   },
    { id: 'cam3', label: "PASSENGER", title: "Curb Side"      },
    { id: 'cam4', label: "INTERIOR",  title: "Cabin"          },
  ],
};

/* App launch dispatcher. Apps in the grid map by `launch` key onto an
   in-app screen name; the App component listens for the 'playbill:navigate'
   CustomEvent and switches screens. Adding Netflix/Plex/Spotify later is
   one case here + a `screen === 'X'` row in app.jsx + a screen JSX file. */
const TV_APPS = {
  launch(app) {
    if (!app) return;
    if (!app.launch) { console.warn('no launch key on app', app.id); return; }
    window.dispatchEvent(new CustomEvent('playbill:navigate', {
      detail: { screen: app.launch },
    }));
  },
};

window.TV_DATA = TV_DATA;
window.TV_APPS = TV_APPS;
