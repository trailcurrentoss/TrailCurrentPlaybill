/* Local Media / Library — movies, music, shows from the onboard Headwaters server */

function LocalView({ focus }) {
  const D = window.TV_DATA;
  const [filter, setFilter] = useState('movies');
  // Library is read from the controller (dvd.libraryList scans the on-disk
  // ~/Videos/Playbill Library tree). We refresh on mount and whenever
  // state.dvd.status transitions to 'done' so a freshly-ripped title shows
  // up without a reload.
  const [ripped, setRipped] = useState({ movies: [], shows: [] });

  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return undefined;
    let mounted = true;
    const refresh = () => {
      window.playbill.controller.command({ action: 'dvd.libraryList' })
        .then((r) => { if (mounted && r) setRipped({ movies: r.movies || [], shows: r.shows || [] }); })
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

  // Merge ripped titles into the corresponding category. The fixture
  // data in data.js stays as a fallback for the empty-library case so
  // a brand-new install still looks populated during onboarding.
  const liveMovies = ripped.movies.length ? ripped.movies.map((m) => ({
    id:    m.id,
    title: m.title,
    year:  m.year,
    meta:  [m.year, m.runtime].filter(Boolean).join(' · '),
    img:   m.posterUrl || '',
    path:  m.path,
  })) : D.movies;
  const liveShows  = ripped.shows.length ? ripped.shows.map((m) => ({
    id:    m.id,
    title: m.title,
    year:  m.year,
    meta:  [m.year, m.runtime].filter(Boolean).join(' · '),
    img:   m.posterUrl || '',
    path:  m.path,
  })) : D.movies.slice().reverse();

  // Resolve a library item to a Playable and hand it to the controller.
  // file:// URLs need encodeURI on the absolute path so spaces and parens
  // in folder names ("Inception (2010)") stay legal.
  function playItem(item) {
    if (!item || !item.path) return;
    if (!window.playbill || !window.playbill.controller) return;
    const url = 'file://' + encodeURI(item.path);
    window.playbill.controller.command({
      action: 'transport.play',
      url,
      mediaType: 'video',
      metadata: {
        title:    item.title,
        subtitle: item.year ? String(item.year) : null,
        artworkUrl: item.img || null,
      },
    }).catch((e) => console.warn('[local] transport.play failed:', e && e.message));
  }

  // Enter / Space while a library card is focused triggers playback.
  // app.jsx's global keydown only handles Enter for the apps row; per-
  // screen Enter handling for the library lives here so the data we
  // already have in this component drives the play call.
  useEffect(() => {
    function onKey(e) {
      if (focus.row !== 'lib-grid') return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (filter !== 'movies' && filter !== 'shows') return;
      const items = filter === 'movies' ? liveMovies : liveShows;
      const item = items[focus.col];
      if (item) playItem(item);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus.row, focus.col, filter, liveMovies, liveShows]);

  const filters = [
    { id: 'movies', label: 'Movies', count: ripped.movies.length || 142 },
    { id: 'shows',  label: 'TV Shows', count: ripped.shows.length || 38 },
    { id: 'music',  label: 'Music', count: 1240 },
    { id: 'home',   label: 'Home Videos', count: 86 },
    { id: 'podcast', label: 'Podcasts', count: 54 },
  ];

  return (
    <div className="local-view">
      <div className="view-hdr" style={{display:'flex', justifyContent:'space-between', alignItems:'flex-end'}}>
        <div>
          <h2>Offline Library</h2>
          <p>Onboard media — 1.2 TB available • Served by Headwaters</p>
        </div>
        <div style={{display:'flex', alignItems:'center', gap:10, color:'var(--tc-primary)', fontSize:12}}>
          <ion-icon name="save-outline" style={{fontSize: 18}}></ion-icon>
          NAS SYNC: COMPLETE
        </div>
      </div>

      <div className="library-filter" style={{marginTop: 20}}>
        {filters.map((f, i) => (
          <button
            key={f.id}
            className={(filter === f.id ? 'active' : '') + (focus.row === 'lib-filter' && focus.col === i ? ' focused' : '')}
            onClick={() => setFilter(f.id)}
          >
            {f.label} <span style={{opacity: 0.5, marginLeft: 6}}>{f.count}</span>
          </button>
        ))}
      </div>

      {filter === 'music' ? (
        <div className="poster-grid" style={{gridTemplateColumns: 'repeat(6, 1fr)'}}>
          {D.music.map((m, i) => (
            <div key={m.id} className={'card square' + (focus.row === 'lib-grid' && focus.col === i ? ' focused' : '')} style={{width: 'auto'}}>
              <div className="thumb" style={{ backgroundImage: `url(${m.img})`, aspectRatio: '1' }}></div>
              <div style={{padding: '10px 12px 12px'}}>
                <div className="title">{m.title}</div>
                <div className="meta">{m.meta}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="poster-grid">
          {(filter === 'movies' ? liveMovies : liveShows).map((m, i) => (
            <div
              key={m.id}
              className={'card poster' + (focus.row === 'lib-grid' && focus.col === i ? ' focused' : '')}
              style={{width: 'auto', cursor: m.path ? 'pointer' : 'default'}}
              onClick={() => playItem(m)}
              role={m.path ? 'button' : undefined}
            >
              <div className="thumb" style={{ backgroundImage: m.img ? `url(${m.img})` : 'none', aspectRatio: '2/3' }}></div>
              <div style={{padding: '8px 10px 10px'}}>
                <div className="title">{m.title}</div>
                <div className="meta">{m.meta}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { LocalView });
