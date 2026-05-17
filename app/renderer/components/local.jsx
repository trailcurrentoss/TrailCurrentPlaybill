/* Local Media / Library — movies, music, shows from the onboard Headwaters
 * server.
 *
 * NAVIGATION CONTRACT (docs/app/navigation.md):
 * Zone-root with two child zones — the filter row (horizontal) and the
 * poster grid (grid). No per-screen keyboard handler; the filter chips and
 * cards are real <button> elements so FocusZones handles the d-pad and the
 * native onClick fires on Enter. */

function LocalView() {
  const [filter, setFilter] = useState('movies');
  // Library is read from the controller (dvd.libraryList scans the on-disk
  // ~/Playbill tree). We refresh on mount and whenever
  // state.dvd.status transitions to 'done' so a freshly-ripped title shows
  // up without a reload.
  const [ripped, setRipped] = useState({ movies: [], shows: [] });
  // Live disk usage for the library partition. null = not yet known (or
  // controller offline); object = { totalBytes, freeBytes, mountpoint }.
  // Replaces the prior hardcoded "1.2 TB available" mock string.
  const [diskInfo, setDiskInfo] = useState(null);

  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return undefined;
    let mounted = true;
    const refresh = () => {
      window.playbill.controller.command({ action: 'dvd.libraryList' })
        .then((r) => { if (mounted && r) setRipped({ movies: r.movies || [], shows: r.shows || [] }); })
        .catch(() => {});
      window.playbill.controller.command({ action: 'library.diskInfo' })
        .then((r) => { if (mounted) setDiskInfo(r || null); })
        .catch(() => {});
    };
    refresh();
    let lastStatus = null;
    const unsub = window.playbill.controller.onState((s) => {
      const next = s && s.dvd && s.dvd.status;
      if (next === 'done' && lastStatus !== 'done') refresh();
      lastStatus = next;
    });
    return () => { mounted = false; if (unsub) unsub(); };
  }, []);

  // Human-readable bytes formatter for the storage chip. We round to
  // tenths up through TB so "892.4 GB available" and "1.2 TB available"
  // both render cleanly without per-unit branching at the call site.
  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    const TB = 1024 ** 4, GB = 1024 ** 3, MB = 1024 ** 2;
    if (n >= TB) return (n / TB).toFixed(1) + ' TB';
    if (n >= GB) return (n / GB).toFixed(1) + ' GB';
    if (n >= MB) return (n / MB).toFixed(0) + ' MB';
    return n + ' B';
  }

  // Real ripped titles only — no mock-fixture fallback. The library
  // chip counts and the grid both reflect actual disk contents. If the
  // user has ripped nothing yet the grid is empty and the count shows
  // 0; that's the correct empty state, not a reason to show fake
  // titles from data.js.
  const liveMovies = ripped.movies.map((m) => ({
    id:    m.id,
    title: m.title,
    year:  m.year,
    meta:  [m.year, m.runtime].filter(Boolean).join(' · '),
    img:   m.posterUrl || '',
    path:  m.path,
  }));
  const liveShows = ripped.shows.map((m) => ({
    id:    m.id,
    title: m.title,
    year:  m.year,
    meta:  [m.year, m.runtime].filter(Boolean).join(' · '),
    img:   m.posterUrl || '',
    path:  m.path,
  }));

  // Resolve a library item to a Playable and hand it to the controller via
  // the shared PLAYBACK helper. That helper also writes to the recent-
  // playback list so the same item shows up in Continue Watching on Home.
  function playItem(item) {
    if (window.PLAYBACK) window.PLAYBACK.playLocal(item);
  }

  // Offline Library is video-only. Audio content lives under the Music
  // top-level SideNav item — kept separate because the metadata, play
  // mode, and detail UI all diverge (industry standard: Apple TV, Plex,
  // Kodi all split by type). Music + Podcasts were removed 2026-05-15.
  // Home Videos is intentionally not listed YET — there's no controller
  // endpoint for it, and we no longer ship mock counts ("Home Videos 86"
  // was a holdover from the design mockup). Add it back when the
  // controller exposes a real source.
  //
  // Counts are LIVE — no `|| fallback` mock numbers. If the library is
  // empty the chip shows 0.
  const filters = [
    { id: 'movies', label: 'Movies',   count: liveMovies.length },
    { id: 'shows',  label: 'TV Shows', count: liveShows.length  },
  ];

  const gridItems = filter === 'movies' ? liveMovies : liveShows;

  return (
    <div
      className="local-view"
      data-zone-root
      data-zone="local"
      data-zone-axis="vertical"
    >
      <div className="view-hdr" style={{display:'flex', justifyContent:'space-between', alignItems:'flex-end'}}>
        <div>
          <h2>Offline Library</h2>
          <p>
            Onboard media
            {diskInfo
              ? ` — ${fmtBytes(diskInfo.freeBytes)} free of ${fmtBytes(diskInfo.totalBytes)}`
              : ''}
          </p>
        </div>
      </div>

      <div
        className="library-filter"
        style={{marginTop: 20}}
        data-zone="local.filter"
        data-zone-axis="horizontal"
      >
        {filters.map((f, i) => (
          <button
            key={f.id}
            type="button"
            className={filter === f.id ? 'active' : ''}
            onClick={() => setFilter(f.id)}
            data-zone-default={i === 0 ? 'true' : undefined}
          >
            {f.label} <span style={{opacity: 0.5, marginLeft: 6}}>{f.count}</span>
          </button>
        ))}
      </div>

      <div
        className="poster-grid"
        data-zone="local.grid"
        data-zone-axis="grid"
      >
        {gridItems.map((m) => (
          <button
            key={m.id}
            type="button"
            className="card poster"
            style={{width: 'auto', textAlign: 'left'}}
            onClick={() => playItem(m)}
            aria-label={m.title}
          >
            <div
              className={'thumb' + (m.img ? '' : ' no-poster')}
              style={{ backgroundImage: m.img ? `url(${m.img})` : 'none', aspectRatio: '2/3' }}
            >
              {!m.img && (
                <div className="no-poster-inner">
                  <ion-icon name="film-outline"></ion-icon>
                  <div className="no-poster-title">{m.title}</div>
                </div>
              )}
            </div>
            <div style={{padding: '8px 10px 10px'}}>
              <div className="title">{m.title}</div>
              <div className="meta">{m.meta}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { LocalView });
