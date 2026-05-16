/* On-Screen Keyboard — modal overlay for text and numeric entry from the
   remote.

   USAGE
     Mark any <input> or <textarea> that should pop the OSK on activation
     with a `data-osk` attribute whose value picks the layout:
       data-osk="text"     → full QWERTY + digits + symbols pages
       data-osk="numeric"  → 3×4 phone-style keypad
     Optional flags:
       data-osk-submit     → when present, the OSK's "Submit" button
                             requestSubmit()s the input's form.
       data-osk-title      → string shown above the preview row.

     focus-zones.js's activate() shim sees the attribute on Enter/Select
     and dispatches `playbill:osk-open` instead of submitting the form,
     so callers don't need to wire any explicit handler — they only need
     to add the attribute.

   ARCHITECTURE
     The keyboard is a modal zone-root tagged `data-zone-root data-zone="osk"
     data-zone-axis="grid"`. Every key is a real <button> and lives as a
     direct leaf of that grid zone (the row <div>s are visual wrappers
     with NO data-zone-axis), so the FocusZones engine routes Up/Down/
     Left/Right between keys using geometry — pressing Down from 'q'
     lands on 'a' as expected. There is NO per-screen keydown handler
     (per the nav contract in docs/app/navigation.md). Back is wired via
     window.PlaybillBackHook for the lifetime of the modal so app.jsx's
     universal Back resolution dismisses the OSK before any other
     escape behavior. */

function OnScreenKeyboard() {
  const [visible,  setVisible]  = useState(false);
  const [layout,   setLayout]   = useState('text');   // 'text' | 'numeric'
  const [page,     setPage]     = useState('alpha');  // 'alpha' | 'sym'
  const [shift,    setShift]    = useState(false);
  const [title,    setTitle]    = useState('');
  const [allowSub, setAllowSub] = useState(false);
  const targetRef = useRef(null);     // the <input>/<textarea> we're editing
  const priorRef  = useRef(null);     // element to restore focus to on close

  // Keep a snapshot of the target's value so the preview row inside the
  // keyboard re-renders as the user types — React's controlled <input>
  // re-renders the SCREEN behind us, not the OSK, so we observe input
  // events on the target and mirror its value into local state.
  const [preview, setPreview] = useState('');

  // ─── External open trigger ──────────────────────────────────────────
  useEffect(() => {
    function onOpen(e) {
      const d = (e && e.detail) || {};
      const tgt = d.target || document.activeElement;
      if (!tgt || (tgt.tagName !== 'INPUT' && tgt.tagName !== 'TEXTAREA')) return;
      if (tgt.disabled || tgt.readOnly) return;
      targetRef.current = tgt;
      priorRef.current  = tgt;
      setLayout(d.layout === 'numeric' ? 'numeric' : 'text');
      setPage('alpha');
      setShift(false);
      setTitle(d.title || tgt.getAttribute('data-osk-title') ||
               tgt.getAttribute('aria-label') ||
               tgt.getAttribute('placeholder') || '');
      setAllowSub(!!(d.submit || tgt.hasAttribute('data-osk-submit')));
      setPreview(tgt.value || '');
      setVisible(true);
    }
    window.addEventListener('playbill:osk-open', onOpen);
    return () => window.removeEventListener('playbill:osk-open', onOpen);
  }, []);

  // ─── Mirror the target's value into preview state ───────────────────
  useEffect(() => {
    if (!visible) return undefined;
    const tgt = targetRef.current;
    if (!tgt) return undefined;
    const onInput = () => setPreview(tgt.value || '');
    tgt.addEventListener('input', onInput);
    return () => tgt.removeEventListener('input', onInput);
  }, [visible]);

  // ─── Back-hook lifecycle: register for the lifetime of the modal ────
  // The hook is tagged with __osk so cleanup only restores `prev` when
  // OUR hook is still installed. If another modal (CD/DVD prompt) opened
  // on top of us and overwrote window.PlaybillBackHook, cleanup is a
  // no-op — we don't want to clobber that newer hook.
  useEffect(() => {
    if (!visible) return undefined;
    const prev = window.PlaybillBackHook;
    const hook = () => { close(false); return true; };
    hook.__osk = true;
    window.PlaybillBackHook = hook;
    return () => {
      if (window.PlaybillBackHook && window.PlaybillBackHook.__osk) {
        window.PlaybillBackHook = prev || null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // On open, drop focus into our zone-root so the first directional press
  // moves between keys instead of recovering focus (the watchdog in
  // focus-zones.js does this too, but it costs one phantom keypress).
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      if (!window.FocusZones || !window.FocusZones.getRoot) return;
      const root = window.FocusZones.getRoot();
      if (root && window.FocusZones.enterZone) window.FocusZones.enterZone(root);
    });
    return () => cancelAnimationFrame(id);
  }, [visible, layout, page]);

  function close(submit) {
    const tgt = targetRef.current;
    setVisible(false);
    setShift(false);
    setPage('alpha');
    // Restore focus to the originating field so the screen behind us
    // resumes its normal d-pad flow.
    requestAnimationFrame(() => {
      try {
        if (priorRef.current && document.contains(priorRef.current)) {
          priorRef.current.focus();
        }
      } catch (_) { /* best effort */ }
      if (submit && tgt && tgt.form && typeof tgt.form.requestSubmit === 'function') {
        try { tgt.form.requestSubmit(); } catch (_) { /* form may not be there */ }
      }
    });
  }

  function insert(chunk) {
    const el = targetRef.current;
    if (!el) return;
    const start = el.selectionStart != null ? el.selectionStart : (el.value || '').length;
    const end   = el.selectionEnd   != null ? el.selectionEnd   : start;
    const v     = el.value || '';
    const max   = el.maxLength;
    const space = (max && max > 0) ? Math.max(0, max - (v.length - (end - start))) : Infinity;
    const piece = chunk.slice(0, space);
    if (!piece) return;
    const newVal = v.slice(0, start) + piece + v.slice(end);
    const proto  = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, newVal);
    else el.value = newVal;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const caret = start + piece.length;
    try { el.selectionStart = el.selectionEnd = caret; } catch (_) { /* number inputs */ }
    setPreview(newVal);
  }

  function backspace() {
    const el = targetRef.current;
    if (!el) return;
    const start = el.selectionStart != null ? el.selectionStart : (el.value || '').length;
    const end   = el.selectionEnd   != null ? el.selectionEnd   : start;
    if (start === 0 && end === 0) return;
    const cutFrom = end > start ? start : start - 1;
    const v = el.value || '';
    const newVal = v.slice(0, cutFrom) + v.slice(end);
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, newVal);
    else el.value = newVal;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    try { el.selectionStart = el.selectionEnd = cutFrom; } catch (_) {}
    setPreview(newVal);
  }

  function onKey(ch) {
    if (layout === 'text' && shift && /^[a-z]$/.test(ch)) {
      insert(ch.toUpperCase());
      // Sticky shift: turn off after one character unless caps-lock'd
      // (a future enhancement could hold-double-tap for caps; one-shot
      // is the iOS / Apple TV / Fire TV behaviour).
      setShift(false);
    } else {
      insert(ch);
    }
  }

  if (!visible) return null;

  return (
    <div className="osk-backdrop" role="dialog" aria-label="On-screen keyboard"
         data-zone-root data-zone="osk" data-zone-axis="grid">
      <div className="osk-card">
        <div className="osk-header">
          {title && <div className="osk-title">{title}</div>}
          <div className="osk-preview" aria-live="polite">
            <span className="osk-preview-value">
              {preview || <span className="osk-preview-placeholder">Start typing…</span>}
            </span>
            <span className="osk-preview-caret" aria-hidden="true">|</span>
          </div>
        </div>

        {layout === 'text'
          ? <OskTextKeys page={page} shift={shift}
                         onKey={onKey} onBackspace={backspace}
                         onShift={() => setShift(s => !s)}
                         onPage={() => setPage(p => p === 'sym' ? 'alpha' : 'sym')}
                         onSpace={() => insert(' ')}
                         onDone={() => close(false)}
                         onSubmit={allowSub ? () => close(true) : null} />
          : <OskNumericKeys onKey={onKey} onBackspace={backspace}
                            onDone={() => close(false)}
                            onSubmit={allowSub ? () => close(true) : null} />}
      </div>
    </div>
  );
}

/* ─── Text (QWERTY) layout ────────────────────────────────────────────
   Five rows of buttons. The row <div>s are visual flex containers ONLY
   — they have no data-zone-axis, so the buttons inside live as direct
   leaves of the outer "osk" grid zone and Up/Down moves between rows
   by geometry. The first letter of the QWERTY row gets data-zone-default
   so the initial focus lands on 'q' (and not on the digits row above). */
function OskTextKeys({ page, shift, onKey, onBackspace, onShift, onPage, onSpace, onDone, onSubmit }) {
  const ALPHA_ROWS = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l',"'"],
    ['z','x','c','v','b','n','m',',','.','/'],
  ];
  const SYM_ROWS = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['!','@','#','$','%','^','&','*','(',')'],
    ['-','_','=','+','[',']','{','}',';',':'],
    ['~','`','<','>','/','\\','|','"',',','.'],
  ];
  const rows = page === 'sym' ? SYM_ROWS : ALPHA_ROWS;
  const showAsUpper = page === 'alpha' && shift;

  return (
    <>
      {rows.map((row, ri) => (
        <div className="osk-row" key={ri}>
          {row.map((ch, ci) => {
            const label = showAsUpper && /^[a-z]$/.test(ch) ? ch.toUpperCase() : ch;
            const isDefault = ri === 1 && ci === 0;
            return (
              <button
                key={ch + ci}
                type="button"
                className="osk-key"
                onClick={() => onKey(ch)}
                data-zone-default={isDefault ? 'true' : undefined}
                aria-label={label}
              >{label}</button>
            );
          })}
        </div>
      ))}

      <div className="osk-row osk-row-action">
        <button type="button" className={'osk-key osk-mod' + (page === 'sym' ? ' on' : '')}
                onClick={onPage} aria-label={page === 'sym' ? 'Letters' : 'Symbols'}>
          {page === 'sym' ? 'ABC' : '!#%'}
        </button>
        <button type="button" className={'osk-key osk-mod' + (shift ? ' on' : '')}
                onClick={onShift} aria-label="Shift" disabled={page === 'sym'}>
          <ion-icon name="arrow-up"></ion-icon>
        </button>
        <button type="button" className="osk-key osk-space"
                onClick={onSpace} aria-label="Space">space</button>
        <button type="button" className="osk-key osk-backspace"
                onClick={onBackspace} aria-label="Backspace">
          <ion-icon name="backspace-outline"></ion-icon>
        </button>
        <button type="button" className="osk-key osk-done"
                onClick={onDone} aria-label="Done">Done</button>
        {onSubmit && (
          <button type="button" className="osk-key osk-submit"
                  onClick={onSubmit} aria-label="Submit">
            <ion-icon name="checkmark"></ion-icon> Go
          </button>
        )}
      </div>
    </>
  );
}

/* ─── Numeric (phone keypad) layout ──────────────────────────────────
   3×4 phone-style — 1-9 across three rows, then a 0 with backspace and
   close on the action row. Row <div>s are visual containers only (no
   data-zone-axis); the keys are direct leaves of the outer grid zone
   so geometric Up/Down moves between rows. */
function OskNumericKeys({ onKey, onBackspace, onDone, onSubmit }) {
  const ROWS = [
    ['1','2','3'],
    ['4','5','6'],
    ['7','8','9'],
  ];
  return (
    <div className="osk-numeric">
      {ROWS.map((row, ri) => (
        <div className="osk-row osk-row-num" key={ri}>
          {row.map((ch, ci) => (
            <button
              key={ch}
              type="button"
              className="osk-key osk-key-num"
              onClick={() => onKey(ch)}
              data-zone-default={ri === 1 && ci === 1 ? 'true' : undefined}
              aria-label={ch}
            >{ch}</button>
          ))}
        </div>
      ))}
      <div className="osk-row osk-row-num">
        <button type="button" className="osk-key osk-key-num osk-backspace"
                onClick={onBackspace} aria-label="Backspace">
          <ion-icon name="backspace-outline"></ion-icon>
        </button>
        <button type="button" className="osk-key osk-key-num"
                onClick={() => onKey('0')} aria-label="0">0</button>
        <button type="button" className="osk-key osk-key-num osk-done"
                onClick={onDone} aria-label="Done">Done</button>
      </div>
      {onSubmit && (
        <div className="osk-row osk-row-num">
          <button type="button" className="osk-key osk-key-num osk-submit osk-submit-wide"
                  onClick={onSubmit} aria-label="Submit">
            <ion-icon name="checkmark"></ion-icon> Submit
          </button>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { OnScreenKeyboard });
