/* DvdPrompt — global overlay that asks the user whether to add a freshly
   inserted DVD to their library, then walks them through metadata
   lookup, optional manual edit, and rip progress.

   Lifecycle:
     1. Subscribe to state.dvd (mirrored from the controller). The slice
        carries everything we need: present, prompt, status, ripping.
     2. When status === 'prompting', render the confirm card with the
        suggested title + Look up / Add as / Not now buttons.
     3. When the user confirms, we call dvd.lookup. If a match is found,
        flip to the 'confirm' card showing poster + title + year + plot.
        If not, flip to a manual-entry form.
     4. dvd.startRip → status flips to 'ripping' on the controller side;
        we show a progress bar reading state.dvd.ripping.percent.
     5. On 'done', show a brief success card with an Eject button.
     6. On 'error', show the error text and a Try Again button.

   The overlay is always mounted (by app.jsx); it renders null when
   state.dvd.status === 'idle' / null. */

function DvdPrompt() {
  const [dvd, setDvd] = useState(null);
  // 'prompt' = first card; 'manual' = user is editing metadata; 'lookup'
  // = waiting on dvd.lookup; 'review' = lookup returned a hit, user is
  // confirming. We derive 'ripping' / 'done' / 'error' from state.dvd.status
  // directly so they survive a re-mount.
  const [phase, setPhase] = useState('prompt');
  const [lookupResult, setLookupResult] = useState(null);
  const [form, setForm] = useState({
    title: '', year: '', kind: 'movie',
    show: '', season: 1, episode: 1,
    plot: '', posterUrl: '',
  });
  const [lookupBusy, setLookupBusy] = useState(false);
  const [omdbMissing, setOmdbMissing] = useState(false);

  // Pull initial state + subscribe to deltas.
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const init = await window.playbill.controller.getState();
        if (cancelled) return;
        if (init.state && init.state.dvd) setDvd(init.state.dvd);
      } catch (_) { /* controller not up yet */ }
    })();
    const unsub = window.playbill.controller.onState((s) => {
      if (!s) return;
      setDvd(s.dvd || null);
    });
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  // When a fresh prompt arrives, seed the manual-entry form with the
  // disc's suggested title + year hint. Without this, opening the manual
  // edit on a fresh prompt would show an empty title field.
  useEffect(() => {
    if (!dvd || !dvd.prompt) return;
    setPhase('prompt');
    setLookupResult(null);
    setOmdbMissing(false);
    setForm((f) => ({
      ...f,
      title: dvd.prompt.suggestedTitle || '',
      year:  dvd.prompt.yearHint || '',
    }));
  }, [dvd && dvd.label]);   // re-seed on disc change

  // Reset to the first phase whenever the controller flips back to idle —
  // covers the "ripped, ejected, inserted a second disc" path without the
  // GUI sticking on the previous phase.
  useEffect(() => {
    if (!dvd) return;
    if (dvd.status === 'idle') setPhase('prompt');
  }, [dvd && dvd.status]);

  if (!dvd) return null;
  // The overlay is visible whenever there is something interesting going
  // on: a prompt, an in-flight rip, or a terminal done/error to acknowledge.
  const visible = dvd.status === 'prompting' || dvd.status === 'ripping'
               || dvd.status === 'done'      || dvd.status === 'error';
  if (!visible) return null;

  const dispatch = (cmd) => window.playbill.controller.command(cmd);

  async function onConfirmAndLookup() {
    setLookupBusy(true);
    try {
      const res = await dispatch({
        action: 'dvd.lookup',
        value: { title: form.title, year: form.year || undefined },
      });
      setLookupBusy(false);
      if (res && res.ok && res.metadata) {
        setLookupResult(res.metadata);
        setForm((f) => ({
          ...f,
          title:     res.metadata.title || f.title,
          year:      res.metadata.year || f.year,
          kind:      res.metadata.kind || 'movie',
          plot:      res.metadata.plot || '',
          posterUrl: res.metadata.posterUrl || '',
        }));
        setPhase('review');
      } else if (res && res.reason === 'no-api-key') {
        setOmdbMissing(true);
        setPhase('manual');
      } else {
        setPhase('manual');
      }
    } catch (e) {
      setLookupBusy(false);
      setPhase('manual');
    }
  }

  function onStartRip() {
    const metadata = {
      title: form.title.trim(),
      year:  form.year ? String(form.year).trim() : undefined,
      kind:  form.kind,
      plot:  form.plot || undefined,
      posterUrl: form.posterUrl || undefined,
    };
    if (!metadata.title) return;
    if (form.kind === 'show') {
      metadata.show    = form.show || form.title;
      metadata.season  = Number(form.season) || 1;
      metadata.episode = Number(form.episode) || 1;
    }
    dispatch({ action: 'dvd.startRip', value: { metadata } })
      .catch((e) => console.warn('[dvd-prompt] startRip failed:', e && e.message));
  }

  function onDismiss() {
    dispatch({ action: 'dvd.dismiss' }).catch(() => {});
  }
  function onCancelRip() {
    dispatch({ action: 'dvd.cancelRip' }).catch(() => {});
  }
  function onEject() {
    dispatch({ action: 'dvd.eject' }).catch(() => {});
    // After a successful rip the user pressed Eject — also clear the
    // 'done' card so the overlay disappears.
    dispatch({ action: 'dvd.dismiss' }).catch(() => {});
  }
  function onAcknowledgeDone() {
    dispatch({ action: 'dvd.dismiss' }).catch(() => {});
  }

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <div className="dvd-prompt-backdrop">
      <div className="dvd-prompt-card">
        <div className="dvd-prompt-header">
          <ion-icon name="disc-outline"></ion-icon>
          <div>
            <div className="dvd-prompt-eyebrow">Optical disc detected</div>
            <div className="dvd-prompt-label">{dvd.label || dvd.device}</div>
          </div>
        </div>

        {dvd.status === 'prompting' && phase === 'prompt' && (
          <>
            <h2>Add to your library?</h2>
            <p>
              We can rip <strong>"{form.title || dvd.prompt && dvd.prompt.suggestedTitle}"</strong> to
              your offline library so you can play it back any time without the disc.
            </p>
            <div className="dvd-prompt-actions">
              <button className="primary" onClick={onConfirmAndLookup} disabled={lookupBusy}>
                {lookupBusy ? 'Looking up…' : 'Yes — look up details'}
              </button>
              <button className="secondary" onClick={() => setPhase('manual')}>Enter details manually</button>
              <button className="ghost" onClick={onDismiss}>Not now</button>
            </div>
          </>
        )}

        {dvd.status === 'prompting' && phase === 'manual' && (
          <>
            <h2>Enter details</h2>
            {omdbMissing && (
              <div className="dvd-prompt-note">
                No internet metadata key configured. Add one under Settings &rarr; Library to
                auto-fill title / poster / plot on future discs.
              </div>
            )}
            <DvdMetadataForm form={form} onChange={setForm} />
            <div className="dvd-prompt-actions">
              <button className="primary" onClick={onStartRip} disabled={!form.title.trim()}>
                Rip to library
              </button>
              <button className="secondary" onClick={() => setPhase('prompt')}>Back</button>
              <button className="ghost" onClick={onDismiss}>Not now</button>
            </div>
          </>
        )}

        {dvd.status === 'prompting' && phase === 'review' && lookupResult && (
          <>
            <h2>Is this right?</h2>
            <div className="dvd-prompt-review">
              {lookupResult.posterUrl && (
                <img src={lookupResult.posterUrl} alt="" className="dvd-prompt-poster" />
              )}
              <div className="dvd-prompt-review-body">
                <div className="dvd-prompt-title-row">
                  <span className="dvd-prompt-title-text">{lookupResult.title}</span>
                  {lookupResult.year && <span className="dvd-prompt-year">{lookupResult.year}</span>}
                </div>
                {lookupResult.rating && (
                  <div className="dvd-prompt-rating">
                    <ion-icon name="star"></ion-icon> {lookupResult.rating} · IMDb
                  </div>
                )}
                {lookupResult.runtime && <div className="dvd-prompt-meta">{lookupResult.runtime}</div>}
                {lookupResult.plot && <p className="dvd-prompt-plot">{lookupResult.plot}</p>}
              </div>
            </div>
            <div className="dvd-prompt-actions">
              <button className="primary" onClick={onStartRip}>Yes — rip to library</button>
              <button className="secondary" onClick={() => setPhase('manual')}>Edit details</button>
              <button className="ghost" onClick={onDismiss}>Cancel</button>
            </div>
          </>
        )}

        {dvd.status === 'ripping' && dvd.ripping && (
          <>
            <h2>Ripping &mdash; {dvd.ripping.currentTitle}</h2>
            <p>Keep the disc in the drive. You can walk away &mdash; the rip continues in the background.</p>
            <div className="dvd-prompt-progress">
              <div className="dvd-prompt-progress-bar" style={{ width: `${Math.max(0, Math.min(100, dvd.ripping.percent || 0))}%` }} />
            </div>
            <div className="dvd-prompt-progress-row">
              <span>{(dvd.ripping.percent || 0).toFixed(1)}%</span>
              {dvd.ripping.etaSec != null && (
                <span>about {formatEta(dvd.ripping.etaSec)} remaining</span>
              )}
            </div>
            <div className="dvd-prompt-actions">
              <button className="ghost" onClick={onCancelRip}>Cancel rip</button>
            </div>
          </>
        )}

        {dvd.status === 'done' && dvd.lastRipped && (
          <>
            <h2>Done.</h2>
            <p>
              <strong>{dvd.lastRipped.title}</strong>
              {dvd.lastRipped.year ? ` (${dvd.lastRipped.year})` : ''} is now in your offline library.
            </p>
            <div className="dvd-prompt-actions">
              <button className="primary" onClick={onEject}>Eject disc</button>
              <button className="secondary" onClick={onAcknowledgeDone}>Keep disc in drive</button>
            </div>
          </>
        )}

        {dvd.status === 'error' && (
          <>
            <h2>Something went wrong</h2>
            <p className="dvd-prompt-error">{dvd.error || 'Unknown error.'}</p>
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

function DvdMetadataForm({ form, onChange }) {
  const set = (k, v) => onChange({ ...form, [k]: v });
  return (
    <div className="dvd-prompt-form">
      <label>
        Title
        <input type="text" value={form.title} onChange={(e) => set('title', e.target.value)} autoFocus />
      </label>
      <label>
        Year
        <input type="text" value={form.year} onChange={(e) => set('year', e.target.value)} placeholder="2010" />
      </label>
      <label>
        Type
        <select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
          <option value="movie">Movie</option>
          <option value="show">TV episode</option>
        </select>
      </label>
      {form.kind === 'show' && (
        <>
          <label>
            Show
            <input type="text" value={form.show} onChange={(e) => set('show', e.target.value)} />
          </label>
          <label>
            Season
            <input type="number" min="1" value={form.season} onChange={(e) => set('season', e.target.value)} />
          </label>
          <label>
            Episode
            <input type="number" min="1" value={form.episode} onChange={(e) => set('episode', e.target.value)} />
          </label>
        </>
      )}
    </div>
  );
}

function formatEta(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

Object.assign(window, { DvdPrompt });
