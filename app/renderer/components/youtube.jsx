/* YouTube screen — search + results + play. Phase 6b.

   Talks to the controller daemon exclusively through window.playbill
   .controller.command(). The controller's source plugin (controller/src/
   sources/youtube/) wraps yt-dlp; this screen is just a presentation +
   input layer. Same pattern as Settings: form-heavy, so we let the
   browser's native focus drive instead of forcing it through the
   tile-grid focus engine. The global keyboard handler in app.jsx already
   bails out for screens that contain inputs/buttons. */

function YoutubeResultCard({ item, onPlay, busy }) {
  const dur = item.duration ? formatDuration(item.duration) : null;
  return (
    <div className={'yt-card' + (busy ? ' busy' : '')}>
      <div className="yt-thumb" style={{ backgroundImage: item.thumbnail ? `url(${item.thumbnail})` : '' }}>
        {dur && <div className="yt-dur">{dur}</div>}
      </div>
      <div className="yt-meta">
        <div className="yt-title">{item.title}</div>
        <div className="yt-channel">{item.channel || '—'}</div>
        {item.viewCount != null && (
          <div className="yt-views">{formatViews(item.viewCount)}</div>
        )}
      </div>
      <button
        className="tv-btn primary"
        disabled={busy}
        onClick={() => onPlay(item)}
      >
        <ion-icon name="play"></ion-icon>
        {busy ? 'Loading…' : 'Play'}
      </button>
    </div>
  );
}

function YoutubeView() {
  const [query, setQuery]       = useState('');
  const [results, setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError]       = useState(null);
  const [playingId, setPlayingId] = useState(null);
  const [nowPlaying, setNowPlaying] = useState(null);
  const inputRef = useRef(null);

  // Autofocus the search box on mount + on every visible-from-elsewhere.
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  // Subscribe to controller state for live now-playing updates so the
  // header can show what's playing across pause/resume/stop/etc. without
  // polling.
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return;
    let unsub;
    (async () => {
      const init = await window.playbill.controller.getState();
      if (init && init.state) setNowPlaying(init.state.nowPlaying || null);
      unsub = window.playbill.controller.onState((s) => {
        setNowPlaying(s ? (s.nowPlaying || null) : null);
      });
    })();
    return () => { if (unsub) unsub(); };
  }, []);

  async function doSearch(e) {
    if (e) e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setError(null); setSearching(true); setResults([]);
    try {
      const r = await window.playbill.controller.command({
        action: 'source.search', sourceId: 'youtube', query: q, limit: 25,
      });
      setResults((r && r.items) || []);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSearching(false);
    }
  }

  async function play(item) {
    setError(null); setPlayingId(item.id);
    try {
      await window.playbill.controller.command({
        action: 'transport.play',
        sourceId: 'youtube',
        itemId: item.id,
        metadata: {
          sourceItemId: item.id,
          title: item.title,
          subtitle: item.channel,
          artworkUrl: item.thumbnail,
          durationMs: item.duration ? item.duration * 1000 : null,
        },
      });
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setPlayingId(null);
    }
  }

  async function stop() {
    try { await window.playbill.controller.command({ action: 'transport.stop' }); }
    catch (e) { setError(String(e.message || e)); }
  }

  async function pauseToggle() {
    try { await window.playbill.controller.command({ action: 'transport.toggle' }); }
    catch (e) { setError(String(e.message || e)); }
  }

  return (
    <div className="yt-view">
      <div className="yt-header">
        <h1><ion-icon name="logo-youtube" style={{color:'#FF0000', verticalAlign:'middle'}}></ion-icon> YouTube</h1>
        <form className="yt-search" onSubmit={doSearch}>
          <ion-icon name="search"></ion-icon>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search YouTube…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={searching}
          />
          <button type="submit" className="tv-btn primary" disabled={searching || !query.trim()}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>
      </div>

      {nowPlaying && (
        <div className="yt-nowplaying">
          <div className="yt-np-title">
            {nowPlaying.paused ? <ion-icon name="pause-circle"></ion-icon> : <ion-icon name="play-circle" style={{color:'#52a441'}}></ion-icon>}
            <strong>{nowPlaying.title || 'Playing'}</strong>
            {nowPlaying.subtitle && <span style={{color:'rgba(255,255,255,0.5)'}}> — {nowPlaying.subtitle}</span>}
          </div>
          <div className="yt-np-actions">
            <button className="tv-btn" onClick={pauseToggle}>
              <ion-icon name={nowPlaying.paused ? 'play' : 'pause'}></ion-icon>
              {nowPlaying.paused ? 'Resume' : 'Pause'}
            </button>
            <button className="tv-btn" onClick={stop}>
              <ion-icon name="stop"></ion-icon> Stop
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="yt-error">
          <ion-icon name="alert-circle"></ion-icon> {error}
        </div>
      )}

      {results.length === 0 && !searching && !error && (
        <div className="yt-empty">
          <ion-icon name="search-outline" style={{fontSize: 48, opacity: 0.3}}></ion-icon>
          <p>Enter a search term above and press Enter.</p>
        </div>
      )}

      <div className="yt-results">
        {results.map((it) => (
          <YoutubeResultCard
            key={it.id}
            item={it}
            onPlay={play}
            busy={playingId === it.id}
          />
        ))}
      </div>
    </div>
  );
}

function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function formatViews(n) {
  if (n < 1000) return `${n} views`;
  if (n < 1_000_000) return `${(n/1000).toFixed(n < 10000 ? 1 : 0)}K views`;
  if (n < 1_000_000_000) return `${(n/1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M views`;
  return `${(n/1_000_000_000).toFixed(1)}B views`;
}

Object.assign(window, { YoutubeView });
