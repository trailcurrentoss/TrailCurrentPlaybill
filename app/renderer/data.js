/* Stage 1 placeholder data — full TV shell rendered with empty content arrays.
   Live TV channels and radio presets are loaded from the main process at
   runtime (see live.jsx and radio.jsx); the rest of these arrays land in a
   later stage when Headwaters NAS / external app integrations come online. */

const TV_DATA = {
  // App-row launchers. Each entry's `launch` field names the screen the
  // 'playbill:navigate' CustomEvent should target. Explore (Trails Nearby)
  // is just another launcher tile, not its own home row — keeping all
  // launchable destinations on the same row makes the home screen scan
  // as "here are your destinations" instead of mixing media and tools.
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
    {
      id: 'explore',
      label: 'Trails Nearby',
      icon: 'map-outline',
      bg: 'linear-gradient(135deg, #3d6b41, #1a3520)',
      launch: 'explore',
    },
    {
      id: 'music',
      label: 'Music',
      icon: 'musical-notes-outline',
      bg: 'linear-gradient(135deg, #6c4ba9, #2a1856)',
      launch: 'music',
    },
  ],

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

/* Recent local playback — drives the home screen's Continue Watching row.
   Stored in localStorage because Stage 1 has no per-user persistent state
   yet; when that exists we'll move this onto the controller so a rig with
   multiple displays stays in sync. Push happens at transport.play time
   (PLAYBACK.playLocal) and is broadcast via a CustomEvent so the home
   screen refreshes without a poll. */
const RECENT_KEY = 'playbill.recentPlayback';
const RECENT_MAX = 8;

function readRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

function writeRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (_) {}
  window.dispatchEvent(new CustomEvent('playbill:recentPlayback'));
}

const PLAYBACK = {
  recent: () => readRecent(),

  pushRecent(item) {
    if (!item || !item.id) return;
    const next = [
      {
        id:        item.id,
        title:     item.title,
        year:      item.year || null,
        meta:      item.meta || (item.year ? String(item.year) : ''),
        img:       item.img || item.posterUrl || null,
        path:      item.path || null,
        playedAt:  Date.now(),
      },
      ...readRecent().filter((r) => r.id !== item.id),
    ].slice(0, RECENT_MAX);
    writeRecent(next);
  },

  // Fire the same controller command both the home and library screens use,
  // so the recent list stays in one place. Callers pass a library-shaped
  // item (must have .path).
  playLocal(item) {
    if (!item || !item.path) return;
    if (!window.playbill || !window.playbill.controller) return;
    PLAYBACK.pushRecent(item);
    const url = 'file://' + encodeURI(item.path);
    window.playbill.controller.command({
      action: 'transport.play',
      sourceId: 'local',
      url,
      mediaType: 'video',
      metadata: {
        title:    item.title,
        subtitle: item.year ? String(item.year) : null,
        artworkUrl: item.img || item.posterUrl || null,
      },
    }).catch((e) => console.warn('[playback] transport.play failed:', e && e.message));
  },
};

window.TV_DATA = TV_DATA;
window.TV_APPS = TV_APPS;
window.PLAYBACK = PLAYBACK;
