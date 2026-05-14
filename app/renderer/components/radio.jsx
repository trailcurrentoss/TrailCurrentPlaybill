/* AM/FM radio view — driven by an RTL-SDR USB dongle. The actual demod /
   audio path lives in the main-process radio service; this view is purely
   focus-driven UI for tuning, presets, and band selection.

   NAV CONTRACT: this screen uses `data-zone-root` + `data-zone-axis`
   per docs/app/navigation.md. There are zero `window.addEventListener`
   calls. Activation (Enter on a focused element) goes through the
   FocusZones engine which clicks the focused element; that maps to the
   button's onClick handler. The only screen-specific keyboard work is on
   the dial control, where ArrowLeft/Right step the frequency rather than
   moving focus — that's bound as an element-level onKeyDown on the dial
   button, which only fires when the dial actually has focus and which
   cooperates with the zone engine (it preventDefaults Left/Right and
   leaves Up/Down/Enter to bubble up to the engine). */

const FM_MIN_HZ = 87_500_000;   // North-American FM band: 87.5–108 MHz
const FM_MAX_HZ = 108_000_000;
const FM_STEP_HZ = 200_000;     // 200 kHz channel spacing in NA

const AM_MIN_HZ =   530_000;    // North-American AM band: 530–1700 kHz
const AM_MAX_HZ = 1_700_000;
const AM_STEP_HZ = 10_000;      // 10 kHz channel spacing in NA

function RadioView() {
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

  async function submitZip(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
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

  // Dial keyboard. Only Left/Right (step frequency) is screen-specific —
  // those would otherwise be consumed by the zone engine as horizontal
  // motion through the dial-row siblings (there is only one focusable
  // button in this row, so the engine would just bounce). Up/Down/Enter
  // bubble up to the zone engine which routes them properly.
  function onDialKey(e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      setFreq(f => clampToBand(f + dir * stepHz));
      e.preventDefault();
      e.stopPropagation();
    }
    // Enter / Space → bubble to onClick (tune)
    // ArrowUp / ArrowDown → bubble to zone engine (escape to band / scan / presets row)
  }

  // ZIP input: the IR remote can't deliver digits, so this is only useful
  // with a USB keyboard, the PWA soft keyboard, or a touch-keyboard pop-up.
  // For all three input mechanisms, native <input value=...> handling works
  // correctly. We don't synthesize key handling here; the controlled value
  // syncs to `zipDraft` via onChange. Submission is via a real <form>, so
  // Enter on the input triggers requestSubmit() (which the FocusZones
  // activate() shim already understands).
  function onZipChange(e) {
    // Strip non-digits, cap at 5.
    const v = (e.target.value || '').replace(/\D/g, '').slice(0, 5);
    setZipDraft(v);
  }

  const ready = adapters && tools;

  return (
    <div
      data-zone-root
      data-zone="radio"
      data-zone-axis="vertical"
      className="radio-view"
    >
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
          {/* Band selector row */}
          <div
            data-zone="radio.band"
            data-zone-axis="horizontal"
            className="radio-band-row"
          >
            <button
              data-zone-default={band === 'fm' ? 'true' : undefined}
              className={'radio-band' + (band === 'fm' ? ' active' : '')}
              onClick={() => switchBand('fm')}
            >FM</button>
            <button
              className={'radio-band' + (band === 'am' ? ' active' : '')}
              onClick={() => switchBand('am')}
            >AM</button>
            <button
              className={'radio-band' + (band === 'scanner' ? ' active' : '')}
              onClick={() => switchBand('scanner')}
              title="Scanner: weather, aviation, marine, ham, more"
            >Scanner</button>
            <button
              className="tv-btn"
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
              <button className="tv-btn" onClick={stop}>
                <ion-icon name="stop-outline"></ion-icon> Stop
              </button>
            ) : null}
          </div>

          {/* FM/AM dial row.
              The dial is a single <button> (so the FocusZones activate()
              shim can click it on Enter); className kept as `radio-dial`
              so the existing CSS applies, with a small button-reset block
              in tv.css (`button.radio-dial`) defeating native button chrome. */}
          {band !== 'scanner' && (
            <div
              data-zone="radio.dial"
              data-zone-axis="horizontal"
              className="radio-dial-row"
            >
              <button
                type="button"
                className="radio-dial"
                onClick={() => tune(freq)}
                onKeyDown={onDialKey}
                title="Enter to tune · ← → step frequency"
              >
                <div className="radio-dial-freq">
                  <span className="num">{formatFreq(freq, band)}</span>
                  <span className="unit">{band === 'fm' ? 'MHz' : 'kHz'}</span>
                </div>
                <div className="radio-dial-hint">
                  ← step down · → step up · Enter to tune
                </div>
                <RadioStrip
                  band={band}
                  freq={freq}
                  minHz={minHz}
                  maxHz={maxHz}
                  stepHz={stepHz}
                />
                <div className="radio-now">
                  {busy ? 'Tuning…' :
                   state.running ? `On air · ${formatFreq(state.frequencyHz, state.band)} ${state.band.toUpperCase()}` :
                   'Press Enter to tune'}
                </div>
              </button>
            </div>
          )}

          {/* Scanner ZIP row.
              The visible 5-slot digit display is unchanged from the original;
              a visually-hidden <input> sits behind it and is what actually
              receives focus + keystrokes. The <label> wrap means focus-within
              applies the same focus-ring styling the rest of the screen uses. */}
          {band === 'scanner' && (
            <div
              data-zone="radio.zip"
              data-zone-axis="horizontal"
              className="radio-dial radio-zip"
            >
              <form className="radio-zip-form" onSubmit={submitZip}>
                <div className="radio-zip-prompt">Enter your US ZIP code</div>
                <label className="radio-zip-slots-label">
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{5}"
                    maxLength={5}
                    autoComplete="off"
                    spellCheck="false"
                    value={zipDraft}
                    onChange={onZipChange}
                    className="radio-zip-input-hidden"
                    aria-label="ZIP code"
                  />
                  <div className="radio-zip-digits" aria-hidden="true">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <span
                        key={i}
                        className={'radio-zip-slot' +
                          (i < zipDraft.length ? ' filled' : '') +
                          (i === zipDraft.length ? ' cursor' : '')}
                      >{zipDraft[i] || '·'}</span>
                    ))}
                  </div>
                </label>
                <div className="radio-dial-hint">
                  Type 5 digits · Enter loads stations
                </div>
                <div className="radio-now">
                  {busy ? 'Loading stations…' :
                   scanner ? `Stations near ${scanner.place} · ZIP ${scanner.zip}` :
                   'Submit a ZIP to populate the local list'}
                </div>
              </form>
            </div>
          )}

          {/* Scan results grid (FM/AM rtl_power output) */}
          {scanResults && scanResults.length > 0 && band !== 'scanner' && (
            <div className="radio-scan-results">
              <div className="radio-scan-hdr">
                Scan: {scanResults.length} station{scanResults.length === 1 ? '' : 's'} found
              </div>
              <div
                data-zone="radio.scan"
                data-zone-axis="grid"
                className="radio-scan-grid"
              >
                {scanResults.map((s) => (
                  <button
                    key={s.frequencyHz}
                    className="radio-scan-result"
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

          {/* Scanner band station list */}
          {band === 'scanner' && scanner && scanner.stations.length > 0 && (
            <div className="radio-scan-results">
              <div className="radio-scan-hdr">
                {scanner.stations.length} stations · {scanner.place}
              </div>
              <div
                data-zone="radio.scan"
                data-zone-axis="grid"
                className="radio-scan-grid"
              >
                {scanner.stations.map((s) => (
                  <button
                    key={s.frequencyHz + (s.label || '')}
                    className="radio-scan-result radio-scanner-tile"
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

          {/* Presets row */}
          <div className="radio-presets">
            <div className="radio-presets-hdr">Presets</div>
            <div
              data-zone="radio.presets"
              data-zone-axis="horizontal"
              className="radio-presets-grid"
            >
              {presets.map((p, i) => (
                <button
                  key={p.slot}
                  className={'radio-preset' + (p.frequencyHz ? '' : ' empty')}
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

function RadioStrip({ band, freq, minHz, maxHz, stepHz }) {
  // Read-only visualization of the dial position. The whole dial control
  // is a single <button> at the zone level, so individual tick clicks
  // would compete with the button's onClick; tick-tap is left to the
  // mouse-driven onClick on the parent button (which tunes the current
  // freq). Keyboard / IR users use ← → on the focused dial to step.
  const total = (maxHz - minHz) / stepHz;
  const pos = (freq - minHz) / (maxHz - minHz);
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
