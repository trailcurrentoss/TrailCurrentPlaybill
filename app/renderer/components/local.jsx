/* Local Media / Library — movies, music, shows from the onboard Headwaters server */

function LocalView({ focus }) {
  const D = window.TV_DATA;
  const [filter, setFilter] = useState('movies');

  const filters = [
    { id: 'movies', label: 'Movies', count: 142 },
    { id: 'shows',  label: 'TV Shows', count: 38 },
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
          {(filter === 'movies' ? D.movies : D.movies.slice().reverse()).map((m, i) => (
            <div key={m.id} className={'card poster' + (focus.row === 'lib-grid' && focus.col === i ? ' focused' : '')} style={{width: 'auto'}}>
              <div className="thumb" style={{ backgroundImage: `url(${m.img})`, aspectRatio: '2/3' }}></div>
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
