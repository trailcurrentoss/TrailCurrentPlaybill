/* YouTube screen — search + results + play. Phase 6b.
 *
 * NAVIGATION CONTRACT (docs/app/navigation.md):
 * Zone-root with two child zones — `youtube.search` (horizontal, holds the
 * input + Search button) and `youtube.results` (vertical, holds the result
 * rows). Each result row is a <button> so FocusZones drives the d-pad and
 * native Enter activates onClick. NO per-screen keyboard handler — earlier
 * versions tried to manually move focus between rows on ArrowUp/Down, which
 * fought with FocusZones doing the same thing and produced the "skip every
 * other row" bug.
 *
 * Search → Down jumps into the results zone (FocusZones escapes the input
 * via parent-sibling sibling lookup). Up from the first result jumps back
 * to the search input the same way. */

// React.forwardRef so YoutubeView can autofocus the first card after a
// search lands — TV-remote users immediately get an Enter-to-play target
// without having to Tab through the search box first.
const YoutubeResultCard = React.forwardRef(function YoutubeResultCard(
  { item, onPlay, busy }, ref
) {
  const dur = item.duration ? formatDuration(item.duration) : null;
  return (
    <button
      ref={ref}
      type="button"
      className={'yt-card' + (busy ? ' busy' : '')}
      aria-label={`Play ${item.title}`}
      disabled={busy}
      onClick={() => onPlay(item)}
    >
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
      <div className="yt-card-cta">
        <ion-icon name={busy ? 'sync' : 'play'}></ion-icon>
        <span>{busy ? 'Loading…' : 'Play'}</span>
      </div>
    </button>
  );
});

function YoutubeView() {
  const [query, setQuery]       = useState('');
  const [results, setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError]       = useState(null);
  const [playingId, setPlayingId] = useState(null);
  const [nowPlaying, setNowPlaying] = useState(null);
  const inputRef       = useRef(null);
  const firstResultRef = useRef(null);

  // Autofocus the search box on mount so the user can start typing
  // immediately. (FocusZones' watchdog would otherwise land focus on the
  // first focusable button in the search zone — Search button or input —
  // and we prefer the input.)
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  // After a search lands, jump focus to the first result so the user can
  // immediately Enter-to-play with a remote.
  useEffect(() => {
    if (results.length > 0 && firstResultRef.current) {
      firstResultRef.current.focus();
    }
  }, [results]);

  // Subscribe to controller state for live now-playing updates so the
  // header can show what's playing across pause/resume/stop/etc.
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
    <div
      data-zone-root
      data-zone="youtube"
      data-zone-axis="vertical"
      className="yt-view"
    >
      <div data-zone="youtube.search" data-zone-axis="horizontal" className="yt-header">
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
            data-osk="text"
            data-osk-submit
            data-osk-title="Search YouTube"
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
            <button type="button" className="tv-btn" onClick={pauseToggle}>
              <ion-icon name={nowPlaying.paused ? 'play' : 'pause'}></ion-icon>
              {nowPlaying.paused ? 'Resume' : 'Pause'}
            </button>
            <button type="button" className="tv-btn" onClick={stop}>
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

      <div data-zone="youtube.results" data-zone-axis="vertical" className="yt-results">
        {results.map((it, i) => (
          <YoutubeResultCard
            key={it.id}
            ref={i === 0 ? firstResultRef : null}
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
