/* AM/FM radio view — driven by an RTL-SDR USB dongle. The actual demod /
   audio path lives in the main-process radio service; this view is purely
   focus-driven UI for tuning, presets, and band selection. */

const FM_MIN_HZ = 87_500_000;   // North-American FM band: 87.5–108 MHz
const FM_MAX_HZ = 108_000_000;
const FM_STEP_HZ = 200_000;     // 200 kHz channel spacing in NA

const AM_MIN_HZ =   530_000;    // North-American AM band: 530–1700 kHz
const AM_MAX_HZ = 1_700_000;
const AM_STEP_HZ = 10_000;      // 10 kHz channel spacing in NA

function RadioView({ focus, setFocus }) {
  const [adapters, setAdapters]   = useState(null);
  const [tools, setTools]         = useState(null);
  const [presets, setPresets]     = useState([]);
  const [state, setState]         = useState({ running: false });
  const [band, setBand]           = useState('fm');
  const [freq, setFreq]           = useState(101_500_000);  // 101.5 FM
  const [error, setError]         = useState(null);
  const [busy, setBusy]           = useState(false);
  const [scanning, setScanning]   = useState(false);
  const [scanResults, setResults] = useState(null);  // FM/AM rtl_power results
  const [zipDraft, setZipDraft]   = useState('');    // digits-typed-so-far for Scanner
  const [scanner, setScanner]     = useState(null);  // { zip, place, stations } once submitted

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, a, p, s] = await Promise.all([
          window.playbill.radio.probeTools(),
          window.playbill.radio.listAdapters(),
          window.playbill.radio.listPresets(),
          window.playbill.radio.getState(),
        ]);
        if (cancelled) return;
        setTools(t); setAdapters(a); setPresets(p); setState(s);
        if (s.running) { setBand(s.band); setFreq(s.frequencyHz); }
      } catch (e) {
        if (!cancelled) setError(String(e.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Subscribe to controller state changes so PWA / CAN button / IR remote
  // -driven tunes reflect in this UI immediately. Without this, radio.jsx
  // only knows what *it* did — external drivers update state.radio in the
  // controller but the UI sits stale until the user clicks Refresh. Apply
  // the delta to local state + dial position; the user's local edits get
  // overwritten when something actually tunes, which is the right behavior
  // for a multi-driver appliance ("show me what's actually playing").
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return;
    let unsub;
    function apply(r) {
      if (!r) return;
      setState(r);
      if (r.band)        setBand(r.band);
      if (r.frequencyHz) setFreq(r.frequencyHz);
    }
    (async () => {
      try {
        const init = await window.playbill.controller.getState();
        if (init && init.state) apply(init.state.radio);
      } catch (_) { /* controller may not be up yet */ }
      unsub = window.playbill.controller.onState((s) => { if (s) apply(s.radio); });
    })();
    return () => { if (unsub) unsub(); };
  }, []);

  const stepHz = band === 'fm' ? FM_STEP_HZ : AM_STEP_HZ;
  const minHz  = band === 'fm' ? FM_MIN_HZ  : AM_MIN_HZ;
  const maxHz  = band === 'fm' ? FM_MAX_HZ  : AM_MAX_HZ;

  function clampToBand(hz) {
    return Math.min(maxHz, Math.max(minHz, hz));
  }

  function switchBand(b) {
    if (b === band) return;
    setBand(b);
    setResults(null);
    if (b === 'fm') setFreq(101_500_000);
    else if (b === 'am') setFreq(1_010_000);
    // Scanner mode keeps whatever frequency is current — the user picks
    // from a list rather than turning a dial.
  }

  async function tune(targetHz, modulation) {
    setError(null); setBusy(true);
    try {
      const r = await window.playbill.radio.tune({ band, frequencyHz: targetHz, modulation });
      setState({ running: true, band: r.band, frequencyHz: r.frequencyHz });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function submitZip() {
    if (zipDraft.length !== 5) {
      setError('Enter a 5-digit ZIP code first.');
      return;
    }
    setError(null); setBusy(true);
    try {
      const r = await window.playbill.radio.lookupScanner({ zip: zipDraft });
      setScanner({ zip: r.zip, place: r.place, stations: r.stations });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function tuneScannerStation(s) {
    setFreq(s.frequencyHz);
    await tune(s.frequencyHz, s.modulation);
  }

  async function stop() {
    setError(null);
    try { await window.playbill.radio.stop(); setState({ running: false }); }
    catch (e) { setError(String(e.message || e)); }
  }

  async function scan() {
    setError(null); setScanning(true); setResults(null);
    try {
      const stations = await window.playbill.radio.scan({ band });
      setResults(stations);
      setState({ running: false });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setScanning(false);
    }
  }

  async function savePreset(slotIdx) {
    const next = presets.map((p, i) =>
      i === slotIdx
        ? { ...p, band, frequencyHz: freq, label: `${formatFreq(freq, band)} ${band.toUpperCase()}` }
        : p
    );
    setPresets(await window.playbill.radio.setPresets(next));
  }

  async function recallPreset(p) {
    if (!p.frequencyHz) return;
    setBand(p.band); setFreq(p.frequencyHz);
    await tune(p.frequencyHz);
  }

  // Keyboard for the centre row.
  //  FM/AM: ←/→ steps frequency, Enter tunes, B toggles band.
  //  Scanner: digits append to the ZIP draft, Backspace removes one, Enter
  //           submits, B cycles bands. The ZIP entry path doesn't depend on
  //           a separate input element — typing while focus.row === 'radio-dial'
  //           is captured here so a TV remote / IR keypad just works.
  useEffect(() => {
    function onKey(e) {
      if (focus.row !== 'radio-dial') return;
      if (band === 'scanner') {
        if (/^[0-9]$/.test(e.key)) {
          setZipDraft((d) => (d + e.key).slice(0, 5));
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          setZipDraft((d) => d.slice(0, -1));
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Enter' || e.key === ' ') {
          submitZip();
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'b' || e.key === 'B') {
          switchBand('fm');
        }
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        setFreq(f => clampToBand(f + dir * stepHz));
        e.preventDefault(); e.stopPropagation();
      } else if (e.key === 'Enter' || e.key === ' ') {
        tune(freq);
      } else if (e.key === 'b' || e.key === 'B') {
        switchBand(band === 'fm' ? 'am' : 'fm');
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focus, freq, band, stepHz, minHz, maxHz, zipDraft]);

  // Keyboard: Enter on the band-selector row activates whichever button is
  // focused. Without this, the focus ring lands on a button but Enter is a
  // noop because the global key handler in app.jsx doesn't dispatch click
  // events. Cols: 0=FM, 1=AM, 2=Scanner, 3=Scan.
  useEffect(() => {
    function onKey(e) {
      if (focus.row !== 'radio-band') return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (focus.col === 0) switchBand('fm');
      else if (focus.col === 1) switchBand('am');
      else if (focus.col === 2) switchBand('scanner');
      else if (focus.col === 3) scan();
      e.preventDefault(); e.stopPropagation();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focus, band]);

  // Enter on a preset → recall.
  useEffect(() => {
    function onKey(e) {
      if (focus.row !== 'radio-presets') return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const p = presets[focus.col];
      if (p) recallPreset(p);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, presets]);

  // Enter on the station-list row → tune. The list holds either FM/AM
  // rtl_power results or scanner-mode stations from the offline DB; both
  // have a frequencyHz field. Scanner items also carry an explicit
  // modulation so the tune call uses the right demod (NBFM for weather/
  // marine/ham, AM for aviation, etc.).
  useEffect(() => {
    function onKey(e) {
      if (focus.row !== 'radio-scan') return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const list = (band === 'scanner' && scanner) ? scanner.stations : scanResults;
      const r = list && list[focus.col];
      if (!r) return;
      setFreq(r.frequencyHz);
      tune(r.frequencyHz, r.modulation);
      e.preventDefault(); e.stopPropagation();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focus, scanResults, scanner, band]);

  // Station-list row is a wrapped CSS grid — visually it has multiple rows of
  // tiles, but the focus engine sees a 1D `col` index. We measure the actual
  // tiles-per-visual-row from the DOM, then translate ArrowUp/Down into
  // ±tilesPerRow column jumps so keyboard nav reaches every tile, not just
  // the first row.
  const scanGridRef = useRef(null);
  const [tilesPerRow, setTilesPerRow] = useState(1);
  useEffect(() => {
    if (!scanGridRef.current) return;
    const measure = () => {
      const tiles = scanGridRef.current && scanGridRef.current.children;
      if (!tiles || tiles.length === 0) return;
      const firstTop = tiles[0].offsetTop;
      let n = 0;
      for (const t of tiles) {
        if (t.offsetTop !== firstTop) break;
        n++;
      }
      if (n > 0) setTilesPerRow(n);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [scanResults, scanner, band]);

  // 2D nav across the wrapped tile grid. Without this, ArrowDown from the
  // first visual tile row jumps straight to the presets row, skipping every
  // tile after column N. ArrowRight is also clamped to the actual list
  // length so the focus ring doesn't disappear into empty schema columns.
  useEffect(() => {
    function onKey(e) {
      if (focus.row !== 'radio-scan') return;
      const list = (band === 'scanner' && scanner) ? scanner.stations : scanResults;
      if (!list || list.length === 0) return;
      let next = focus.col;
      let consumed = false;
      if (e.key === 'ArrowRight') {
        if (focus.col + 1 < list.length) { next = focus.col + 1; consumed = true; }
      } else if (e.key === 'ArrowLeft') {
        if (focus.col > 0) { next = focus.col - 1; consumed = true; }
        // col === 0 — let app.jsx open the side nav.
      } else if (e.key === 'ArrowDown') {
        const tryCol = focus.col + tilesPerRow;
        if (tryCol < list.length) { next = tryCol; consumed = true; }
        // No further tiles below — fall through to presets row.
      } else if (e.key === 'ArrowUp') {
        if (focus.col >= tilesPerRow) { next = focus.col - tilesPerRow; consumed = true; }
        // No tiles above — fall through to dial / zip row.
      }
      if (consumed && setFocus) {
        setFocus((f) => ({ ...f, col: next }));
        e.preventDefault(); e.stopPropagation();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focus, scanResults, scanner, band, tilesPerRow, setFocus]);

  const ready = adapters && tools;

  return (
    <div className="radio-view">
      <div className="view-hdr">
        <h2>Radio</h2>
        <p>{radioStatus({ tools, adapters, state })}</p>
      </div>

      {error && <div className="live-error">{error}</div>}

      {ready && !tools.rtl_fm && (
        <EmptyState icon="warning-outline" title="rtl_fm not installed"
          body="Install rtl-sdr (`apt install rtl-sdr`) to enable FM/AM tuning." />
      )}
      {ready && tools.rtl_fm && adapters.length === 0 && (
        <EmptyState icon="hardware-chip-outline" title="No RTL-SDR detected"
          body="Plug in the RTL-SDR dongle and reload this view." />
      )}

      {ready && tools.rtl_fm && adapters.length > 0 && (
        <>
          <div className="radio-band-row">
            <button
              className={'radio-band' + (band === 'fm' ? ' active' : '') +
                         (focus.row === 'radio-band' && focus.col === 0 ? ' focused' : '')}
              onClick={() => switchBand('fm')}
            >FM</button>
            <button
              className={'radio-band' + (band === 'am' ? ' active' : '') +
                         (focus.row === 'radio-band' && focus.col === 1 ? ' focused' : '')}
              onClick={() => switchBand('am')}
            >AM</button>
            <button
              className={'radio-band' + (band === 'scanner' ? ' active' : '') +
                         (focus.row === 'radio-band' && focus.col === 2 ? ' focused' : '')}
              onClick={() => switchBand('scanner')}
              title="Scanner: weather, aviation, marine, ham, more"
            >Scanner</button>
            <button
              className={'tv-btn' +
                         (focus.row === 'radio-band' && focus.col === 3 ? ' focused' : '')}
              onClick={scan}
              disabled={scanning || band === 'scanner'}
              title={band === 'scanner'
                ? 'Scan is for FM/AM bands; in Scanner mode the list comes from the offline database'
                : `Scan the ${band.toUpperCase()} band for stations`}
            >
              <ion-icon name={scanning ? 'sync-outline' : 'search-outline'}></ion-icon>
              {scanning ? 'Scanning…' : 'Scan'}
            </button>
            <div className="radio-band-spacer" />
            {state.running ? (
              <button className="tv-btn"
                onClick={stop}
              ><ion-icon name="stop-outline"></ion-icon> Stop</button>
            ) : null}
          </div>

          {band !== 'scanner' && (
            <div className={'radio-dial' + (focus.row === 'radio-dial' ? ' focused' : '')}>
              <div className="radio-dial-freq">
                <span className="num">{formatFreq(freq, band)}</span>
                <span className="unit">{band === 'fm' ? 'MHz' : 'kHz'}</span>
              </div>
              <div className="radio-dial-hint">
                ← step down · → step up · Enter to tune · B to switch band
              </div>
              <RadioStrip
                band={band}
                freq={freq}
                minHz={minHz}
                maxHz={maxHz}
                stepHz={stepHz}
                onPick={(hz) => { setFreq(hz); tune(hz); }}
              />
              <div className="radio-now">
                {busy ? 'Tuning…' :
                 state.running ? `On air · ${formatFreq(state.frequencyHz, state.band)} ${state.band.toUpperCase()}` :
                 'Press Enter to tune'}
              </div>
            </div>
          )}

          {band === 'scanner' && (
            <div className={'radio-dial radio-zip' + (focus.row === 'radio-dial' ? ' focused' : '')}>
              <div className="radio-zip-prompt">Enter your US ZIP code</div>
              <div className="radio-zip-digits">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className={'radio-zip-slot' +
                      (i < zipDraft.length ? ' filled' : '') +
                      (i === zipDraft.length ? ' cursor' : '')}
                  >{zipDraft[i] || '·'}</span>
                ))}
              </div>
              <div className="radio-dial-hint">
                Type 5 digits · Backspace deletes · Enter loads stations · B back to FM
              </div>
              <div className="radio-now">
                {busy ? 'Loading stations…' :
                 scanner ? `Stations near ${scanner.place} · ZIP ${scanner.zip}` :
                 'Submit a ZIP to populate the local list'}
              </div>
            </div>
          )}

          {scanResults && scanResults.length > 0 && band !== 'scanner' && (
            <div className="radio-scan-results">
              <div className="radio-scan-hdr">
                Scan: {scanResults.length} station{scanResults.length === 1 ? '' : 's'} found
              </div>
              <div className="radio-scan-grid" ref={scanGridRef}>
                {scanResults.map((s, i) => (
                  <button
                    key={s.frequencyHz}
                    className={'radio-scan-result' +
                      (focus.row === 'radio-scan' && focus.col === i ? ' focused' : '')}
                    onClick={() => { setFreq(s.frequencyHz); tune(s.frequencyHz); }}
                    title={`Tune ${formatFreq(s.frequencyHz, band)} ${band.toUpperCase()}`}
                  >
                    <div className="freq">{formatFreq(s.frequencyHz, band)}</div>
                    <div className="band">{band.toUpperCase()}</div>
                    <div className="signal">{Math.round(s.signalDb)} dB</div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {scanResults && scanResults.length === 0 && band !== 'scanner' && (
            <div className="radio-scan-results">
              <div className="radio-scan-hdr">
                Scan: no stations above noise floor — try a different antenna or band
              </div>
            </div>
          )}

          {band === 'scanner' && scanner && scanner.stations.length > 0 && (
            <div className="radio-scan-results">
              <div className="radio-scan-hdr">
                {scanner.stations.length} stations · {scanner.place}
              </div>
              <div className="radio-scan-grid" ref={scanGridRef}>
                {scanner.stations.map((s, i) => (
                  <button
                    key={s.frequencyHz + (s.label || '')}
                    className={'radio-scan-result radio-scanner-tile' +
                      (focus.row === 'radio-scan' && focus.col === i ? ' focused' : '')}
                    onClick={() => tuneScannerStation(s)}
                    title={`Tune ${(s.frequencyHz / 1e6).toFixed(3)} MHz · ${s.modulation.toUpperCase()} · ${s.label}`}
                  >
                    <div className="freq">{(s.frequencyHz / 1e6).toFixed(3)}</div>
                    <div className="band">{s.category} · {s.modulation.toUpperCase()}</div>
                    <div className="signal">{s.label}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="radio-presets">
            <div className="radio-presets-hdr">Presets</div>
            <div className="radio-presets-grid">
              {presets.map((p, i) => (
                <button
                  key={p.slot}
                  className={'radio-preset' +
                             (p.frequencyHz ? '' : ' empty') +
                             (focus.row === 'radio-presets' && focus.col === i ? ' focused' : '')}
                  onClick={() => p.frequencyHz ? recallPreset(p) : savePreset(i)}
                  onContextMenu={(e) => { e.preventDefault(); savePreset(i); }}
                  title={p.frequencyHz ? 'Click to recall · right-click to overwrite' : 'Click to save current frequency here'}
                >
                  <div className="slot">{p.slot}</div>
                  {p.frequencyHz
                    ? <>
                        <div className="freq">{formatFreq(p.frequencyHz, p.band)}</div>
                        <div className="band">{p.band.toUpperCase()}</div>
                      </>
                    : <div className="empty-label">Empty · Enter to save</div>}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RadioStrip({ band, freq, minHz, maxHz, stepHz, onPick }) {
  const total = (maxHz - minHz) / stepHz;
  const pos = (freq - minHz) / (maxHz - minHz);
  // Show a few neighboring channels around the cursor for the dial feel.
  const span = band === 'fm' ? 12 : 20;
  const cursor = Math.round((freq - minHz) / stepHz);
  const tickStart = Math.max(0, cursor - Math.floor(span / 2));
  const tickEnd   = Math.min(total, tickStart + span);
  const ticks = [];
  for (let i = tickStart; i <= tickEnd; i++) {
    const hz = minHz + i * stepHz;
    ticks.push({ i, hz, isCursor: i === cursor });
  }
  return (
    <div className="radio-strip">
      <div className="radio-strip-bar"><div className="fill" style={{ width: `${pos * 100}%` }} /></div>
      <div className="radio-strip-ticks">
        {ticks.map(t => (
          <div
            key={t.i}
            className={'tick' + (t.isCursor ? ' cursor' : '')}
            onClick={() => onPick(t.hz)}
          >
            {t.isCursor ? <span className="lbl">{formatFreq(t.hz, band)}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function radioStatus({ tools, adapters, state }) {
  if (!tools) return 'Probing radio…';
  if (!tools.rtl_fm) return 'rtl_fm not installed';
  if (!adapters || adapters.length === 0) return 'No RTL-SDR detected';
  if (state.running) return `On air · ${formatFreq(state.frequencyHz, state.band)} ${state.band.toUpperCase()}`;
  const n = adapters.length;
  return `${n} dongle${n === 1 ? '' : 's'} ready · standby`;
}

function formatFreq(hz, band) {
  if (!hz) return '—';
  if (band === 'fm') return (hz / 1e6).toFixed(1);
  return Math.round(hz / 1e3).toString();
}

Object.assign(window, { RadioView });
