/* Stage 1 placeholder data — full TV shell rendered with empty content arrays.
   The row titles and screen scaffolding stay so the shell is exercised in full;
   actual content (continue-watching, trails, movies, music, EPG, library) lands
   in Stage 2 when Headwaters NAS / antenna / external app integrations come online. */

const TV_DATA = {
  featured: {
    title: "TrailCurrent Playbill",
    tag: "Stage 1 · Empty Shell",
    meta: ["No content yet", "Wire in Stage 2"],
    rating: "—",
    desc: "Headwaters media library, OTA antenna tuner, vehicle telemetry, exterior cameras, and external streaming apps wire up in Stage 2. For now this is the Playbill shell rendered against empty data so the design system, focus navigation, and theme can be validated end-to-end on the desktop.",
    bg: null,
  },

  continue:  [],
  apps:      [],
  rowTrails: [],
  movies:    [],
  music:     [],
  channels:  [],

  // Camera tile labels stay — they're static UI scaffolding for the Rig screen,
  // not media. The actual feeds wire up in Stage 2.
  cams: [
    { id: 'cam1', label: "FRONT",     title: "Front · 4K"     },
    { id: 'cam2', label: "REAR",      title: "Rear · 1080p"   },
    { id: 'cam3', label: "PASSENGER", title: "Curb Side"      },
    { id: 'cam4', label: "INTERIOR",  title: "Cabin"          },
  ],
};

window.TV_DATA = TV_DATA;
