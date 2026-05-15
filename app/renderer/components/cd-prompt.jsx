/* CdPrompt — global overlay that asks the user whether to add a freshly
   inserted audio CD to their music library, then walks them through
   MusicBrainz metadata lookup, optional manual edit, and rip progress.

   Lifecycle mirrors DvdPrompt one-for-one:
     1. Subscribe to state.music. The slice carries everything we need.
     2. status === 'prompting' → render the confirm card. The audio CD
        case has no useful volume label, so we don't echo a "suggested
        title" — instead the primary action is "Look up details" which
        kicks off a MusicBrainz TOC lookup directly.
     3. lookup result → review card with album art / artist / tracklist.
     4. music.startRip → status flips to 'ripping'; we show "Ripping
        track N of M" with per-track progress.
     5. done / error → success / error card.

   The overlay sits next to DvdPrompt in app.jsx — only one can be
   active at a time because a single optical drive only holds one disc. */

function CdPrompt() {
  const [music, setMusic] = useState(null);
  const [phase, setPhase] = useState('prompt');
  const [lookupResult, setLookupResult] = useState(null);
  // Manual / search-fallback form fields.
  const [form, setForm] = useState({ album: '', artist: '' });
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupNote, setLookupNote] = useState(null); // 'not-found' | 'no-network' | null

  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const init = await window.playbill.controller.getState();
        if (cancelled) return;
        if (init.state && init.state.music) setMusic(init.state.music);
      } catch (_) { /* controller not up yet */ }
    })();
    const unsub = window.playbill.controller.onState((s) => {
      if (!s) return;
      setMusic(s.music || null);
    });
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  // Reset phase whenever a new disc arrives.
  useEffect(() => {
    if (!music || !music.present) return;
    setPhase('prompt');
    setLookupResult(null);
    setLookupNote(null);
    setForm({ album: '', artist: '' });
  }, [music && music.discid]);

  useEffect(() => {
    if (!music) return;
    if (music.status === 'idle') setPhase('prompt');
  }, [music && music.status]);

  // Whether the modal is currently visible — drives back-hook lifecycle.
  // Same caveat as DvdPrompt: this component is ALWAYS mounted in app.jsx
  // and returns null when idle, so the back-hook must NOT be registered
  // on mount with `[]` deps. Key on `modalVisible` so the hook only
  // exists while the modal is on screen; otherwise it would intercept
  // Back from every unrelated screen and wrongly fire music.dismiss.
  const modalVisible = !!(music && (
    music.status === 'prompting' || music.status === 'ripping' ||
    music.status === 'done'      || music.status === 'error'));

  useEffect(() => {
    if (!modalVisible) return undefined;
    window.PlaybillBackHook = () => {
      if (window.playbill && window.playbill.controller) {
        window.playbill.controller.command({ action: 'music.dismiss' }).catch(() => {});
      }
      return true;
    };
    return () => { if (window.PlaybillBackHook) delete window.PlaybillBackHook; };
  }, [modalVisible]);

  if (!music) return null;
  if (!modalVisible) return null;

  const dispatch = (cmd) => window.playbill.controller.command(cmd);

  async function onConfirmAndLookup() {
    setLookupBusy(true);
    setLookupNote(null);
    try {
      const res = await dispatch({ action: 'music.lookup' });
      setLookupBusy(false);
      if (res && res.ok && res.metadata) {
        setLookupResult(res.metadata);
        setForm({
          album:  res.metadata.title || '',
          artist: res.metadata.artist || '',
        });
        setPhase('review');
      } else {
        // No TOC match. Drop into the search/manual phase — user types
        // album + artist and we re-query MusicBrainz.
        setLookupNote('not-found');
        setPhase('search');
      }
    } catch (e) {
      setLookupBusy(false);
      setLookupNote('no-network');
      setPhase('search');
    }
  }

  async function onSearch() {
    if (!form.album && !form.artist) return;
    setLookupBusy(true);
    setLookupNote(null);
    try {
      const res = await dispatch({
        action: 'music.search',
        value: { album: form.album || undefined, artist: form.artist || undefined },
      });
      setLookupBusy(false);
      if (res && res.ok && res.metadata) {
        setLookupResult(res.metadata);
        setForm({
          album:  res.metadata.title  || form.album,
          artist: res.metadata.artist || form.artist,
        });
        setPhase('review');
      } else {
        setLookupNote('not-found');
      }
    } catch (_) {
      setLookupBusy(false);
      setLookupNote('no-network');
    }
  }

  function onStartRip() {
    if (!lookupResult) return;
    // Rip-time metadata is whatever MusicBrainz returned, edited title
    // and artist from the form if the user changed them. Tracks come
    // from the lookup — there's no manual track-entry path; if the user
    // somehow has a CD MB has never seen, they need internet to rip it
    // with usable tags. The .flac files still rip even with a fallback
    // "Track NN" naming, which we trigger by building a synthetic
    // metadata payload when the user clicks "Rip without metadata".
    const metadata = {
      ...lookupResult,
      title:  form.album.trim() || lookupResult.title,
      artist: form.artist.trim() || lookupResult.artist,
    };
    dispatch({ action: 'music.startRip', value: { metadata } })
      .catch((e) => console.warn('[cd-prompt] startRip failed:', e && e.message));
  }

  function onRipWithoutMetadata() {
    // Last-ditch: rip every track on the disc as "Track NN" with the
    // user's typed album/artist (or "Unknown"). The CD watcher has the
    // track count in music.ntracks; build a synthetic tracklist matching.
    const ntracks = music.ntracks || 0;
    if (!ntracks) return;
    const metadata = {
      title:  form.album.trim()  || 'Unknown Album',
      artist: form.artist.trim() || 'Unknown Artist',
      tracks: Array.from({ length: ntracks }, (_, i) => ({
        number: i + 1,
        title:  `Track ${String(i + 1).padStart(2, '0')}`,
        artist: form.artist.trim() || 'Unknown Artist',
      })),
      source: 'manual',
    };
    dispatch({ action: 'music.startRip', value: { metadata } })
      .catch((e) => console.warn('[cd-prompt] startRip-manual failed:', e && e.message));
  }

  function onDismiss()    { dispatch({ action: 'music.dismiss' }).catch(() => {}); }
  function onCancelRip()  { dispatch({ action: 'music.cancelRip' }).catch(() => {}); }
  function onEject() {
    dispatch({ action: 'music.eject' }).catch(() => {});
    dispatch({ action: 'music.dismiss' }).catch(() => {});
  }
  function onAcknowledgeDone() { dispatch({ action: 'music.dismiss' }).catch(() => {}); }

  const totalMinutes = music.lengthSec ? Math.round(music.lengthSec / 60) : null;
  const discLabel = music.discid
    ? `${music.ntracks || '?'}-track CD · ${totalMinutes || '?'} min`
    : 'Audio CD';

  return (
    <div
      className="dvd-prompt-backdrop"
      data-zone-root
      data-zone="cd-prompt"
      data-zone-axis="horizontal"
    >
      <div className="dvd-prompt-card">
        <div className="dvd-prompt-header">
          <ion-icon name="musical-notes-outline"></ion-icon>
          <div>
            <div className="dvd-prompt-eyebrow">Audio CD detected</div>
            <div className="dvd-prompt-label">{discLabel}</div>
          </div>
        </div>

        {music.status === 'prompting' && phase === 'prompt' && (
          <>
            <h2>Add this CD to your library?</h2>
            <p>
              We can rip every track to FLAC and store them in your offline music library
              so you can play this album any time without the disc.
            </p>
            <div className="dvd-prompt-actions">
              <button className="primary" onClick={onConfirmAndLookup} disabled={lookupBusy}>
                {lookupBusy ? 'Looking up…' : 'Yes — look up album'}
              </button>
              <button className="secondary" onClick={() => setPhase('search')}>Search by name</button>
              <button className="ghost" onClick={onDismiss}>Not now</button>
            </div>
          </>
        )}

        {music.status === 'prompting' && phase === 'search' && (
          <>
            <h2>Search the album</h2>
            {lookupNote === 'not-found' && (
              <div className="dvd-prompt-note">
                We couldn't auto-match the disc against MusicBrainz. Type the album / artist
                to search by name, or skip metadata and rip the tracks as "Track NN".
              </div>
            )}
            {lookupNote === 'no-network' && (
              <div className="dvd-prompt-note">
                Couldn't reach MusicBrainz (no internet?). You can still rip without metadata —
                the tracks will be named "Track NN" and you can rename them later.
              </div>
            )}
            <CdMetadataSearchForm form={form} onChange={setForm} />
            <div className="dvd-prompt-actions">
              <button className="primary" onClick={onSearch} disabled={lookupBusy || (!form.album && !form.artist)}>
                {lookupBusy ? 'Searching…' : 'Search'}
              </button>
              <button className="secondary" onClick={onRipWithoutMetadata}>Rip without metadata</button>
              <button className="ghost" onClick={onDismiss}>Cancel</button>
            </div>
          </>
        )}

        {music.status === 'prompting' && phase === 'review' && lookupResult && (
          <>
            <h2>Is this right?</h2>
            <div className="dvd-prompt-review">
              {lookupResult.coverArtUrl && (
                <img
                  src={lookupResult.coverArtUrl}
                  alt=""
                  className="dvd-prompt-poster"
                  style={{ width: 140, height: 140, objectFit: 'cover' }}
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
              )}
              <div className="dvd-prompt-review-body">
                <div className="dvd-prompt-title-row">
                  <span className="dvd-prompt-title-text">{lookupResult.title}</span>
                  {lookupResult.year && <span className="dvd-prompt-year">{lookupResult.year}</span>}
                </div>
                <div className="dvd-prompt-meta">{lookupResult.artist}</div>
                {lookupResult.tracks && lookupResult.tracks.length > 0 && (
                  <div className="cd-prompt-tracklist">
                    {lookupResult.tracks.slice(0, 6).map((t) => (
                      <div key={t.number} className="cd-prompt-track">
                        <span className="cd-prompt-track-num">{String(t.number).padStart(2, '0')}</span>
                        <span className="cd-prompt-track-title">{t.title}</span>
                        {t.durationMs ? (
                          <span className="cd-prompt-track-dur">{formatTrackDur(t.durationMs)}</span>
                        ) : null}
                      </div>
                    ))}
                    {lookupResult.tracks.length > 6 && (
                      <div className="cd-prompt-track-more">…and {lookupResult.tracks.length - 6} more</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="dvd-prompt-actions">
              <button className="primary" onClick={onStartRip}>Yes — rip to library</button>
              <button className="secondary" onClick={() => setPhase('search')}>Search again</button>
              <button className="ghost" onClick={onDismiss}>Cancel</button>
            </div>
          </>
        )}

        {music.status === 'ripping' && music.ripping && (
          <>
            <h2>Ripping &mdash; {music.ripping.currentTitle}</h2>
            <p>
              Keep the disc in the drive. You can walk away &mdash; the rip continues
              in the background.
            </p>
            <div className="dvd-prompt-progress">
              <div
                className="dvd-prompt-progress-bar"
                style={{ width: `${Math.max(0, Math.min(100, music.ripping.percent || 0))}%` }}
              />
            </div>
            <div className="dvd-prompt-progress-row">
              <span>Track {music.ripping.trackIndex || 0} of {music.ripping.ntracks || 0}</span>
              <span>{(music.ripping.percent || 0).toFixed(0)}%</span>
            </div>
            <div className="dvd-prompt-actions">
              <button className="ghost" onClick={onCancelRip}>Cancel rip</button>
            </div>
          </>
        )}

        {music.status === 'done' && music.lastRipped && (
          <>
            <h2>Done.</h2>
            <p>
              <strong>{music.lastRipped.title}</strong>
              {music.lastRipped.artist ? ` by ${music.lastRipped.artist}` : ''} is now in
              your offline music library.
            </p>
            <div className="dvd-prompt-actions">
              <button className="primary" onClick={onEject}>Eject disc</button>
              <button className="secondary" onClick={onAcknowledgeDone}>Keep disc in drive</button>
            </div>
          </>
        )}

        {music.status === 'error' && (
          <>
            <h2>Something went wrong</h2>
            <p className="dvd-prompt-error">{music.error || 'Unknown error.'}</p>
            <div className="dvd-prompt-actions">
              <button className="primary" onClick={() => setPhase('prompt')}>Try again</button>
              <button className="ghost" onClick={onDismiss}>Dismiss</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CdMetadataSearchForm({ form, onChange }) {
  const set = (k, v) => onChange({ ...form, [k]: v });
  return (
    <div className="dvd-prompt-form">
      <label>
        Album
        <input
          type="text"
          value={form.album}
          onChange={(e) => set('album', e.target.value)}
          autoFocus
          placeholder="Kind of Blue"
        />
      </label>
      <label>
        Artist
        <input
          type="text"
          value={form.artist}
          onChange={(e) => set('artist', e.target.value)}
          placeholder="Miles Davis"
        />
      </label>
    </div>
  );
}

function formatTrackDur(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

Object.assign(window, { CdPrompt });
