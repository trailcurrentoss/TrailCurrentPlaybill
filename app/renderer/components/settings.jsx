/* Settings — Connection screen (Phase 1b) and a placeholder for the rest
   of the categories (Display / Hardware / Sources / About) the architecture
   doc lists. The Connection sub-screen is the only fully-wired one for now;
   it's the gate-out-of-unconfigured first-run experience. */

function ConnectionStatusPill({ status, lastError }) {
  const map = {
    unconfigured: { label: 'Not configured', color: '#888' },
    configured:   { label: 'Configured · waiting',  color: '#888' },
    connecting:   { label: 'Connecting…',  color: '#d9a300' },
    connected:    { label: 'Connected',    color: '#52a441' },
    error:        { label: 'Error',        color: '#ff5453' },
  };
  const m = map[status] || map.unconfigured;
  return (
    <div style={{display:'inline-flex', alignItems:'center', gap:8, padding:'4px 12px',
                 borderRadius:9999, background:'rgba(255,255,255,0.06)',
                 border:`1px solid ${m.color}40`, color:m.color, fontSize:12,
                 letterSpacing:0.5, textTransform:'uppercase'}}>
      <span style={{width:8, height:8, borderRadius:'50%', background:m.color, boxShadow:`0 0 10px ${m.color}80`}}></span>
      {m.label}{lastError ? ' — ' + lastError : ''}
    </div>
  );
}

// ─── Field-level + structured error helpers ──────────────────────────

// Client-side validators — catch obviously-bad input before submitting so
// the user fixes typos here instead of waiting for a 401 from Headwaters.
// Each returns null on OK or a short user-facing message on failure.
const validate = {
  username(v) {
    if (!v || !v.trim())            return 'Username is required.';
    if (v !== v.trim())             return 'Username has leading or trailing whitespace.';
    if (/\s/.test(v))               return 'Username can\'t contain spaces.';
    return null;
  },
  password(v) {
    if (!v)                         return 'Password is required.';
    if (/^\s+$/.test(v))            return 'Password can\'t be only whitespace.';
    if (v !== v.trim())             return 'Password has leading or trailing whitespace (this trips up brokers — paste it again).';
    return null;
  },
  caCert(v, opts = {}) {
    if (!v || !v.trim()) {
      return opts.alreadyProvided ? null
        : 'Paste the Headwaters CA certificate so this Playbill can verify the broker\'s TLS identity.';
    }
    if (!/-----BEGIN CERTIFICATE-----/.test(v) || !/-----END CERTIFICATE-----/.test(v)) {
      return 'That doesn\'t look like a PEM certificate. It should start with "-----BEGIN CERTIFICATE-----" and end with "-----END CERTIFICATE-----".';
    }
    return null;
  },
  apiKey(v) {
    if (!v || !v.trim())            return 'API key is required.';
    const t = v.trim();
    if (!/^rv_[A-Za-z0-9_-]+$/.test(t))
                                    return 'Headwaters API keys start with "rv_" and contain only letters, numbers, dashes, or underscores.';
    if (t.length < 20)              return 'That key looks too short. Make sure you copied the full value from Headwaters.';
    return null;
  },
};

// Maps a server-side error `kind` to an icon. Kept here so the UI knows
// only this small vocabulary; the controller's classifier owns the rules.
const ERROR_ICON = {
  dns:     'globe-outline',
  refused: 'close-circle-outline',
  network: 'cloud-offline-outline',
  timeout: 'time-outline',
  tls:     'shield-half-outline',
  auth:    'key-outline',
  http:    'alert-circle-outline',
  unknown: 'warning-outline',
  empty:   'warning-outline',
};

function FieldError({ children }) {
  if (!children) return null;
  return (
    <div style={{marginTop:6, fontSize:12, color:'#ff5453',
                  display:'inline-flex', alignItems:'center', gap:6}}>
      <ion-icon name="alert-circle-outline"></ion-icon>
      {children}
    </div>
  );
}

function ErrorAlert({ kind, title, message }) {
  return (
    <div style={{padding:'12px 14px', background:'rgba(255,84,83,0.1)',
                 border:'1px solid rgba(255,84,83,0.3)', borderRadius:8,
                 color:'#ff5453', fontSize:13,
                 display:'flex', alignItems:'flex-start', gap:10}}>
      <ion-icon name={ERROR_ICON[kind] || ERROR_ICON.unknown}
                style={{fontSize:18, flexShrink:0, marginTop:1}}></ion-icon>
      <div>
        {title && <div style={{fontWeight:600, marginBottom:4}}>{title}</div>}
        <div>{message}</div>
      </div>
    </div>
  );
}

function SuccessAlert({ title, message }) {
  return (
    <div style={{padding:'12px 14px', background:'rgba(82,164,65,0.1)',
                 border:'1px solid rgba(82,164,65,0.3)', borderRadius:8,
                 color:'#52a441', fontSize:13,
                 display:'flex', alignItems:'center', gap:10}}>
      <ion-icon name="checkmark-circle-outline" style={{fontSize:18}}></ion-icon>
      <div>
        {title && <span style={{fontWeight:600, marginRight:6}}>{title}</span>}
        {message}
      </div>
    </div>
  );
}

function ConnectionForm({ initial, onSave, busy }) {
  const [username, setUsername] = useState(initial?.username || '');
  const [password, setPassword] = useState('');
  const [caCert,   setCaCert]   = useState('');
  const [fieldErrs, setFieldErrs] = useState({});

  const submit = async (e) => {
    e.preventDefault();
    // Client-side first pass — catch empty / malformed before round trip.
    const errs = {
      username: validate.username(username),
      password: validate.password(password),
      caCert:   validate.caCert(caCert, { alreadyProvided: !!initial?.caCertProvided }),
    };
    setFieldErrs(errs);
    if (errs.username || errs.password || errs.caCert) return;

    await onSave({
      username: username.trim(),
      password,
      caCertProvided: !!caCert || !!initial?.caCertProvided,
      ca: caCert || undefined,
    });
  };

  const labelStyle = { display:'block', fontSize:12, letterSpacing:1,
                       textTransform:'uppercase', color:'rgba(255,255,255,0.6)',
                       marginBottom:6 };
  const inputStyle = (hasErr) => ({
    width:'100%', padding:'12px 14px', background:'rgba(255,255,255,0.05)',
    border:`1px solid ${hasErr ? 'rgba(255,84,83,0.6)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius:8, color:'#fff', font:'14px var(--font-sans)',
  });

  return (
    <form onSubmit={submit} style={{maxWidth:600, display:'flex', flexDirection:'column', gap:18}} noValidate>
      <div style={{fontSize:11, color:'rgba(255,255,255,0.4)'}}>
        Connecting to <code>mqtts://headwaters.local:8883</code> (the rig's Headwaters host).
      </div>
      <div>
        <label style={labelStyle}>Username</label>
        <input style={inputStyle(!!fieldErrs.username)} type="text" placeholder="rig MQTT username"
               value={username} onChange={(e) => setUsername(e.target.value)}
               autoComplete="username"
               data-osk="text" data-osk-title="MQTT username" />
        <FieldError>{fieldErrs.username}</FieldError>
      </div>
      <div>
        <label style={labelStyle}>Password</label>
        <input style={inputStyle(!!fieldErrs.password)} type="password"
               placeholder={initial ? '••••••••' : 'rig MQTT password'}
               value={password} onChange={(e) => setPassword(e.target.value)}
               autoComplete="current-password"
               data-osk="text" data-osk-title="MQTT password" />
        <FieldError>{fieldErrs.password}</FieldError>
      </div>
      <div>
        <label style={labelStyle}>CA Certificate (PEM) {initial?.caCertProvided && '(currently set; leave blank to keep)'}</label>
        <textarea style={{...inputStyle(!!fieldErrs.caCert), minHeight:120, fontFamily:'var(--font-mono)', fontSize:12}}
                  placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                  value={caCert} onChange={(e) => setCaCert(e.target.value)} />
        <FieldError>{fieldErrs.caCert}</FieldError>
      </div>
      <div style={{display:'flex', gap:12}}>
        <button type="submit" className="tv-btn primary" disabled={busy}>
          <ion-icon name="save-outline"></ion-icon>
          {busy ? 'Saving…' : 'Save & Connect'}
        </button>
      </div>
    </form>
  );
}

// Commands the user runs in a terminal to install / remove the
// TrailCurrent CA. Linux trust stores don't share state, so we have to
// touch every one any local app might consult:
//
//   /etc/ssl/certs/ca-certificates.crt              curl, wget, system tools
//   ~/.pki/nssdb/                                   deb-packaged Chromium/Brave
//   ~/snap/chromium/current/.pki/nssdb/             snap Chromium (confined)
//   ~/snap/firefox/common/.mozilla/firefox/*/       snap Firefox (confined)
//   ~/.mozilla/firefox{,-esr}/*.default*/           deb-packaged Firefox/ESR
//
// libnss3-tools (provides `certutil`) ships in the image. Snap browsers
// keep their NSS dbs inside the snap's confined ~/snap/<pkg>/ tree —
// host ~/.pki/nssdb is invisible to them, which is why a system-only
// install made curl/Firefox-ESR happy but left snap Chromium warning.
// For the snap Chromium path we mkdir + initialize the db if absent so
// the import works even before the user has launched the browser.
const TRUST_INSTALL_CMD = [
  'sudo install -m 0644 ~/.config/trailcurrent-playbill/ca.pem /usr/local/share/ca-certificates/trailcurrent.crt && \\',
  'sudo update-ca-certificates && \\',
  'mkdir -p ~/snap/chromium/current/.pki/nssdb && \\',
  '[ -f ~/snap/chromium/current/.pki/nssdb/cert9.db ] || certutil -d sql:$HOME/snap/chromium/current/.pki/nssdb -N --empty-password && \\',
  'for db in ~/.pki/nssdb ~/snap/chromium/current/.pki/nssdb ~/snap/firefox/common/.mozilla/firefox/*.default*/ ~/.mozilla/firefox-esr/*.default*/ ~/.mozilla/firefox/*.default*/; do \\',
  '  [ -d "$db" ] || continue; \\',
  '  certutil -d sql:"$db" -D -n "TrailCurrent CA" 2>/dev/null; \\',
  '  certutil -d sql:"$db" -A -t "C,," -n "TrailCurrent CA" -i /usr/local/share/ca-certificates/trailcurrent.crt; \\',
  'done',
].join('\n');
const TRUST_REMOVE_CMD = [
  'sudo rm -f /usr/local/share/ca-certificates/trailcurrent.crt && \\',
  'sudo update-ca-certificates --fresh && \\',
  'for db in ~/.pki/nssdb ~/snap/chromium/current/.pki/nssdb ~/snap/firefox/common/.mozilla/firefox/*.default*/ ~/.mozilla/firefox-esr/*.default*/ ~/.mozilla/firefox/*.default*/; do \\',
  '  [ -d "$db" ] || continue; \\',
  '  certutil -d sql:"$db" -D -n "TrailCurrent CA" 2>/dev/null || true; \\',
  'done',
].join('\n');

// Copyable terminal-command block. Used to surface privileged actions
// (sudo update-ca-certificates) that the daemon won't perform on its own
// — the user runs them explicitly so the elevation is auditable.
function CommandBlock({ title, hint, command, accent = '#52a441' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) { /* clipboard may be unavailable; user can select manually */ }
  }
  return (
    <div style={{marginTop:18, padding:'14px 16px', background:'rgba(255,255,255,0.03)',
                 border:`1px solid ${accent}40`, borderRadius:8}}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, marginBottom:8}}>
        <div>
          <div style={{font:'600 12px var(--font-sans)', letterSpacing:1, textTransform:'uppercase', color: accent}}>
            {title}
          </div>
          {hint && <div style={{fontSize:12, color:'rgba(255,255,255,0.55)', marginTop:4}}>{hint}</div>}
        </div>
        <button type="button" onClick={copy}
                style={{padding:'6px 12px', background:'rgba(255,255,255,0.06)',
                        border:'1px solid rgba(255,255,255,0.12)', borderRadius:6,
                        color:'#fff', fontSize:12, cursor:'pointer',
                        display:'inline-flex', alignItems:'center', gap:6}}>
          <ion-icon name={copied ? 'checkmark-outline' : 'copy-outline'}></ion-icon>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre style={{margin:0, padding:'10px 12px', background:'rgba(0,0,0,0.35)',
                    border:'1px solid rgba(255,255,255,0.06)', borderRadius:6,
                    fontFamily:'var(--font-mono)', fontSize:12, color:'#cfe',
                    whiteSpace:'pre-wrap', wordBreak:'break-all', overflow:'auto'}}>
        {command}
      </pre>
    </div>
  );
}

function HeadwatersScreen({ ctrlState }) {
  const [conn, setConn] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // After Forget, surface the removal command for one cycle.
  const [showRemoveCmd, setShowRemoveCmd] = useState(false);

  // API key state — co-located on this screen because everything here
  // configures how this Playbill talks to its Headwaters host (broker for
  // realtime nav/state, API key for HTTP calls).
  const apiKeySet = !!(ctrlState && ctrlState.headwaters && ctrlState.headwaters.apiKeySet);
  const [apiKey, setApiKey]             = useState('');
  const [apiKeyBusy, setApiKeyBusy]     = useState(false);
  const [apiKeySaved, setApiKeySaved]   = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cur = await window.playbill.controller.command({ action: 'connection.get' });
        setConn(cur);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, []);

  // After saving, poll state.connection.status (already mirrored into
  // ctrlState by the parent subscription) until MQTT either connects or
  // errors out. The classifier in the controller categorises whatever the
  // broker reported (DNS / refused / TLS / auth / timeout) so the UI can
  // show a specific message instead of "broker connection failed".
  const VALIDATE_MS = 12000;
  const [brokerResult, setBrokerResult] = useState(null);   // {ok, kind?, message?}
  async function waitForMqttResult() {
    const start = Date.now();
    while (Date.now() - start < VALIDATE_MS) {
      let snap = null;
      try { snap = (await window.playbill.controller.getState()).state; }
      catch (_) { /* keep trying */ }
      const c = snap && snap.connection;
      if (c) {
        if (c.status === 'connected') return { ok: true };
        if (c.status === 'error')     return { ok: false,
                                                kind: c.lastErrorKind || 'unknown',
                                                message: c.lastError || 'Broker connection failed.' };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, kind: 'timeout',
             message: `The broker didn't respond within ${VALIDATE_MS/1000} seconds. Check that Headwaters is powered on and on the same network as this Playbill.` };
  }

  const onSave = async ({ username, password, caCertProvided, ca }) => {
    setBusy(true); setBrokerResult(null);
    try {
      if (ca && ca.trim()) {
        await window.playbill.controller.command({ action: 'connection.setCa', value: ca });
      }
      await window.playbill.controller.command({
        action: 'connection.set',
        value:  { username, password, caCertProvided: !!ca || !!conn?.caCertProvided },
      });
      const result = await waitForMqttResult();
      setBrokerResult(result);
      const cur = await window.playbill.controller.command({ action: 'connection.get' });
      setConn(cur);
    } catch (e) {
      // Surface dispatch / IPC / schema rejections — without this the form
      // appears to do nothing on a controller-side failure (no status, no
      // attempt) because the exception goes nowhere.
      setBrokerResult({ ok: false, kind: 'unknown', message: String(e.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const onForget = async () => {
    if (!confirm('Forget Headwaters credentials? Playbill will return to the unconfigured state. To also remove the trusted CA from the system store you will need to run the removal command shown after this.')) return;
    setBusy(true);
    try {
      await window.playbill.controller.command({ action: 'connection.clear' });
      setConn(null);
      setShowRemoveCmd(true);
    } finally { setBusy(false); }
  };

  // apiKeyResult tracks the structured outcome so we can render a kinded
  // error block (same shape brokerResult uses).
  const [apiKeyResult, setApiKeyResult] = useState(null);  // {ok, kind?, message?}
  const [apiKeyFieldErr, setApiKeyFieldErr] = useState(null);

  async function saveApiKey(e) {
    if (e) e.preventDefault();
    setApiKeyResult(null); setApiKeySaved(false);

    // Client-side first: format check catches paste errors instantly.
    const fieldErr = validate.apiKey(apiKey);
    setApiKeyFieldErr(fieldErr);
    if (fieldErr) return;

    setApiKeyBusy(true);
    try {
      // Validate against Headwaters BEFORE persisting — controller
      // returns {ok, kind, error} so we render the right icon.
      const v = await window.playbill.controller.command({
        action: 'headwaters.validateApiKey',
        value:  { apiKey: apiKey.trim() },
      });
      if (!v.ok) { setApiKeyResult({ ok: false, kind: v.kind || 'unknown', message: v.error }); return; }
      await window.playbill.controller.command({
        action: 'headwaters.setSettings',
        value:  { apiKey: apiKey.trim() },
      });
      setApiKey('');
      setApiKeySaved(true);
    } catch (e) {
      setApiKeyResult({ ok: false, kind: 'unknown', message: String(e.message || e) });
    } finally { setApiKeyBusy(false); }
  }

  async function clearApiKey() {
    if (!confirm('Remove the stored Headwaters API key?')) return;
    setApiKeyBusy(true); setApiKeyResult(null); setApiKeySaved(false);
    try {
      await window.playbill.controller.command({ action: 'headwaters.clear' });
    } catch (e) {
      setApiKeyResult({ ok: false, kind: 'unknown', message: String(e.message || e) });
    } finally { setApiKeyBusy(false); }
  }

  const sectionHdr = { font:'600 11px var(--font-sans)', letterSpacing:2,
                       textTransform:'uppercase', color:'rgba(255,255,255,0.45)',
                       margin:'0 0 14px' };
  const labelStyle = { display:'block', fontSize:12, letterSpacing:1,
                       textTransform:'uppercase', color:'rgba(255,255,255,0.6)',
                       marginBottom:6 };
  const inputStyle = { width:'100%', padding:'12px 14px', background:'rgba(255,255,255,0.05)',
                       border:'1px solid rgba(255,255,255,0.1)', borderRadius:8,
                       color:'#fff', font:'14px var(--font-sans)' };

  return (
    <div style={{padding:'40px 60px', maxWidth:900}}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24}}>
        <h1 style={{margin:0, font:'700 32px var(--font-sans)', letterSpacing:-1}}>Headwaters</h1>
        <ConnectionStatusPill
          status={ctrlState?.connection?.status || 'unconfigured'}
          lastError={ctrlState?.connection?.lastError}
        />
      </div>
      <p style={{color:'rgba(255,255,255,0.6)', fontSize:14, marginBottom:32, maxWidth:680}}>
        Configure how this Playbill talks to its Headwaters host: the MQTT broker for realtime
        nav/state, the CA that signs trailcurrent.* hostnames, and the API key used for HTTP
        calls into Headwaters services.
      </p>

      <section data-zone="settings.headwaters.broker" data-zone-axis="vertical"
               style={{marginBottom:32}}>
        <h2 style={sectionHdr}>Broker</h2>
        {brokerResult && brokerResult.ok && (
          <div style={{marginBottom:14}}>
            <SuccessAlert title="Broker connected." message="Remote commands and live state are flowing." />
          </div>
        )}
        {brokerResult && !brokerResult.ok && (
          <div style={{marginBottom:14}}>
            <ErrorAlert kind={brokerResult.kind} title="Broker connection failed" message={brokerResult.message} />
          </div>
        )}
        {loading
          ? <div style={{color:'rgba(255,255,255,0.4)'}}>Loading current configuration…</div>
          : <ConnectionForm initial={conn} onSave={onSave} busy={busy} />}
        {conn?.caCertProvided && (
          <CommandBlock
            title="Install CA system-wide"
            hint="Run this in a terminal so curl, Chromium, and Firefox all trust trailcurrent.* hostnames. Updates the system trust store AND each browser's per-profile NSS database (Linux browsers don't read /etc/ssl/certs). Fully quit any open browsers afterwards so they re-read the cert store on next launch. Replaces any prior TrailCurrent cert."
            command={TRUST_INSTALL_CMD}
          />
        )}
        {showRemoveCmd && (
          <CommandBlock
            title="Remove TrailCurrent CA system-wide"
            hint="Run this to delete the cert from both the system store and every browser's NSS database. The credentials are already cleared."
            command={TRUST_REMOVE_CMD}
            accent="#ff5453"
          />
        )}
      </section>

      <section data-zone="settings.headwaters.apikey" data-zone-axis="vertical"
               style={{marginTop:32, paddingTop:24, borderTop:'1px solid rgba(255,255,255,0.08)'}}>
        <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:14}}>
          <h2 style={{...sectionHdr, margin:0}}>API Key</h2>
          {apiKeySet && (
            <div style={{display:'inline-flex', alignItems:'center', gap:8, padding:'4px 12px',
                         borderRadius:9999, background:'rgba(82,164,65,0.1)',
                         border:'1px solid rgba(82,164,65,0.3)', color:'#52a441',
                         fontSize:11, letterSpacing:0.5, textTransform:'uppercase'}}>
              <span style={{width:6, height:6, borderRadius:'50%', background:'#52a441',
                            boxShadow:'0 0 8px #52a44180'}}></span>
              Key stored
            </div>
          )}
        </div>
        <p style={{color:'rgba(255,255,255,0.5)', fontSize:13, marginBottom:18, maxWidth:680}}>
          Authenticates HTTP calls to the Headwaters APIs. Stored on this Playbill at file mode
          0600 and never returned over IPC after saving — paste it again to rotate.
        </p>
        {apiKeyResult && !apiKeyResult.ok && (
          <div style={{marginBottom:14}}>
            <ErrorAlert kind={apiKeyResult.kind} title="API key validation failed" message={apiKeyResult.message} />
          </div>
        )}
        {apiKeySaved && (
          <div style={{marginBottom:14}}>
            <SuccessAlert title="API key saved." message="Headwaters accepted the key on validation." />
          </div>
        )}
        <form onSubmit={saveApiKey} style={{maxWidth:600, display:'flex', flexDirection:'column', gap:14}} noValidate>
          <div>
            <label style={labelStyle}>API Key {apiKeySet && '(currently set; paste again to rotate)'}</label>
            <input style={{...inputStyle,
                            border: `1px solid ${apiKeyFieldErr ? 'rgba(255,84,83,0.6)' : 'rgba(255,255,255,0.1)'}`}}
                   type="password"
                   placeholder={apiKeySet ? '••••••••' : 'rv_...'}
                   value={apiKey} onChange={(e) => { setApiKey(e.target.value); setApiKeyFieldErr(null); }}
                   autoComplete="off" spellCheck="false"
                   data-osk="text" data-osk-title="Headwaters API key" />
            <FieldError>{apiKeyFieldErr}</FieldError>
          </div>
          <div style={{display:'flex', gap:12}}>
            <button type="submit" className="tv-btn primary" disabled={apiKeyBusy || !apiKey.trim()}>
              <ion-icon name="save-outline"></ion-icon>
              {apiKeyBusy ? 'Validating…' : 'Save API key'}
            </button>
            {apiKeySet && (
              <button type="button" className="tv-btn" onClick={clearApiKey} disabled={apiKeyBusy}
                      style={{background:'rgba(255,84,83,0.1)', color:'#ff5453'}}>
                <ion-icon name="trash-outline"></ion-icon> Remove API key
              </button>
            )}
          </div>
        </form>
      </section>

      {conn && (
        <div style={{marginTop:32, paddingTop:24, borderTop:'1px solid rgba(255,255,255,0.08)'}}>
          <button className="tv-btn" onClick={onForget} disabled={busy}
                  style={{background:'rgba(255,84,83,0.1)', color:'#ff5453'}}>
            <ion-icon name="trash-outline"></ion-icon>
            Forget credentials
          </button>
        </div>
      )}
    </div>
  );
}

function DeviceScreen({ ctrlState }) {
  const dev = ctrlState?.device;
  const [name, setName] = useState(ctrlState?.settings?.device?.name || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await window.playbill.controller.command({
        action: 'settings.patch',
        value: { device: { id: ctrlState.settings.device.id, name } },
      });
    } finally { setBusy(false); }
  };
  return (
    <div style={{padding:'40px 60px', maxWidth:900}}>
      <h1 style={{margin:'0 0 24px', font:'700 32px var(--font-sans)', letterSpacing:-1}}>Device</h1>
      <p style={{color:'rgba(255,255,255,0.6)', fontSize:14, marginBottom:32}}>
        A friendly name shown to other devices on the rig (e.g. "Living Room", "Bedroom").
        The topic-slug ID is fixed and cannot be changed.
      </p>
      <div style={{display:'flex', flexDirection:'column', gap:18, maxWidth:600}}>
        <div>
          <label style={{display:'block', fontSize:12, letterSpacing:1, textTransform:'uppercase',
                          color:'rgba(255,255,255,0.6)', marginBottom:6}}>Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                 style={{width:'100%', padding:'12px 14px', background:'rgba(255,255,255,0.05)',
                          border:'1px solid rgba(255,255,255,0.1)', borderRadius:8, color:'#fff',
                          font:'14px var(--font-sans)'}}
                 data-osk="text" data-osk-title="Device name" />
        </div>
        <div>
          <label style={{display:'block', fontSize:12, letterSpacing:1, textTransform:'uppercase',
                          color:'rgba(255,255,255,0.6)', marginBottom:6}}>Device ID (read-only)</label>
          <code style={{display:'block', padding:'12px 14px', background:'rgba(255,255,255,0.03)',
                          border:'1px dashed rgba(255,255,255,0.1)', borderRadius:8,
                          color:'rgba(255,255,255,0.5)', fontSize:13}}>
            {dev?.id || '—'}
          </code>
        </div>
        <div>
          <button onClick={save} disabled={busy} className="tv-btn primary">
            <ion-icon name="save-outline"></ion-icon> {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsView({ focus }) {
  const [ctrlState, setCtrlState]       = useState(null);
  const [ctrlConnected, setCtrlConnected] = useState(false);
  const [tab, setTab] = useState('headwaters');

  useEffect(() => {
    let unsubState, unsubStatus;
    (async () => {
      const initial = await window.playbill.controller.getState();
      setCtrlState(initial.state);
      setCtrlConnected(initial.connected);
      unsubState  = window.playbill.controller.onState((s)  => setCtrlState(s));
      unsubStatus = window.playbill.controller.onStatus((s) => setCtrlConnected(s.connected));
    })();
    return () => { unsubState && unsubState(); unsubStatus && unsubStatus(); };
  }, []);

  // Settings is a two-zone screen: a vertical tabs rail on the left and
  // a vertical content area on the right with multiple sub-sections per
  // tab. Without a back-hook, pressing Back from deep in a sub-section
  // unwinds the user all the way out of Settings — a 4-step drop that
  // skips every intermediate level. This hook implements the canonical
  // multi-level Back: if focus is anywhere inside `settings.content`,
  // climb one level to the active tab. If focus is on the tab rail,
  // return false so app.jsx's universal Back opens the SideNav with
  // the Settings menu item highlighted. Same PlaybillBackHook pattern
  // Music uses for album-detail → album-grid; see docs/app/navigation.md.
  useEffect(() => {
    window.PlaybillBackHook = () => {
      const active = document.activeElement;
      if (!active || active === document.body) return false;
      // Focus already on the tabs rail → let goBack take the next step.
      if (active.closest('[data-zone="settings.tabs"]')) return false;
      // Focus is in content. Move it to the active tab and consume Back.
      const tabBtn = document.querySelector('[data-tab-active="true"]');
      if (tabBtn) { try { tabBtn.focus(); } catch (_) {} return true; }
      return false;
    };
    return () => { if (window.PlaybillBackHook) delete window.PlaybillBackHook; };
  }, []);

  if (!ctrlConnected) {
    return (
      <div style={{padding:'120px 60px', textAlign:'center', color:'rgba(255,255,255,0.6)'}}>
        <div style={{fontSize:48, marginBottom:16}}><ion-icon name="cloud-offline-outline"></ion-icon></div>
        <h2 style={{font:'700 28px var(--font-sans)', margin:'0 0 8px'}}>Controller daemon not running</h2>
        <p style={{maxWidth:520, margin:'0 auto', fontSize:14}}>
          The playbill-controller systemd service must be running for Playbill to function.
          Start it with <code style={{background:'rgba(255,255,255,0.06)', padding:'2px 6px', borderRadius:4}}>
          systemctl --user start playbill-controller</code>, or run it manually with{' '}
          <code style={{background:'rgba(255,255,255,0.06)', padding:'2px 6px', borderRadius:4}}>
          node controller/src/index.js</code>.
        </p>
      </div>
    );
  }

  const tabs = [
    { id: 'headwaters', label: 'Headwaters', icon: 'water-outline' },
    { id: 'device',     label: 'Device',     icon: 'hardware-chip-outline' },
    { id: 'audio',      label: 'Audio',      icon: 'volume-medium-outline' },
    { id: 'youtube',    label: 'YouTube',    icon: 'logo-youtube' },
    { id: 'library',    label: 'Library',    icon: 'film-outline' },
    // Phase 2+: { id: 'sources', label: 'Sources', icon: 'apps-outline' },
    // Phase 2+: { id: 'display', label: 'Display', icon: 'color-palette-outline' },
    // Phase 2+: { id: 'about',   label: 'About',   icon: 'information-circle-outline' },
  ];

  return (
    // data-zone-root marks this screen as using the spatial focus engine
    // (see docs/app/navigation.md). The d-pad walks zones automatically;
    // no per-screen keyboard handling needed.
    <div data-zone-root data-zone="settings" data-zone-axis="horizontal"
         style={{position:'absolute', inset:0, display:'flex'}}>
      <div data-zone="settings.tabs" data-zone-axis="vertical"
           style={{width:240, padding:'80px 0 0', borderRight:'1px solid rgba(255,255,255,0.06)',
                    background:'rgba(0,0,0,0.2)', flexShrink:0}}>
        <div style={{padding:'0 24px 16px', font:'700 11px var(--font-sans)',
                       letterSpacing:2, color:'rgba(255,255,255,0.4)', textTransform:'uppercase'}}>
          Settings
        </div>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
                  onFocus={() => setTab(t.id)}
                  data-tab={t.id}
                  data-tab-active={tab===t.id ? 'true' : undefined}
                  data-zone-default={tab===t.id ? 'true' : undefined}
                  style={{display:'flex', alignItems:'center', gap:12, width:'100%',
                          padding:'12px 24px', background:tab===t.id?'rgba(82,164,65,0.12)':'transparent',
                          border:0, borderLeft:tab===t.id?'3px solid var(--tc-primary)':'3px solid transparent',
                          color:tab===t.id?'#fff':'rgba(255,255,255,0.6)',
                          font:'500 14px var(--font-sans)', cursor:'pointer', textAlign:'left'}}>
            <ion-icon name={t.icon} style={{fontSize:18}}></ion-icon>
            {t.label}
          </button>
        ))}
      </div>
      <div data-zone="settings.content" data-zone-axis="vertical"
           style={{flex:1, overflow:'auto'}}>
        {tab === 'headwaters' && <HeadwatersScreen ctrlState={ctrlState} />}
        {tab === 'device'     && <DeviceScreen     ctrlState={ctrlState} />}
        {tab === 'audio'      && <AudioScreen      ctrlState={ctrlState} />}
        {tab === 'youtube'    && <YoutubeScreen    ctrlState={ctrlState} />}
        {tab === 'library'    && <LibraryScreen    ctrlState={ctrlState} />}
      </div>
    </div>
  );
}

// ─── YouTube settings ────────────────────────────────────────────────
//
// Search and playback are anonymous (yt-dlp scrapes the public web) and
// always work — no credentials, no quota, no Google project required.
// Signing in is optional and unlocks per-account features (subscriptions,
// watch later, liked playlists). Sign-in requires a one-time, ~10-min
// Google Cloud Console setup where the user creates their own OAuth
// client and pastes the two values below. See the linked guide for the
// step-by-step.

function YoutubeScreen({ ctrlState }) {
  const yt = (ctrlState && ctrlState.youtube) || {};
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);
  const [showCreds, setShowCreds] = useState(false);

  // Credential entry form state — separate from sign-in busy spinner.
  const [clientId, setClientId]         = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [credsBusy, setCredsBusy]       = useState(false);
  const [credsErr, setCredsErr]         = useState(null);
  const [credsSaved, setCredsSaved]     = useState(false);

  const sectionHdr = { font:'600 11px var(--font-sans)', letterSpacing:2,
                       textTransform:'uppercase', color:'rgba(255,255,255,0.45)',
                       margin:'0 0 14px' };
  const labelStyle = { display:'block', fontSize:12, letterSpacing:1,
                       textTransform:'uppercase', color:'rgba(255,255,255,0.6)',
                       marginBottom:6 };
  const inputStyle = { width:'100%', padding:'12px 14px', background:'rgba(255,255,255,0.05)',
                       border:'1px solid rgba(255,255,255,0.1)', borderRadius:8,
                       color:'#fff', font:'14px var(--font-sans)' };

  async function startSignIn() {
    setError(null); setBusy(true);
    try {
      await window.playbill.controller.command({ action: 'youtube.signInStart' });
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

  async function cancelSignIn() {
    setBusy(true);
    try { await window.playbill.controller.command({ action: 'youtube.signInCancel' }); }
    finally { setBusy(false); }
  }

  async function signOut() {
    if (!confirm('Sign out of YouTube?')) return;
    setBusy(true);
    try { await window.playbill.controller.command({ action: 'youtube.signOut' }); }
    catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

  async function saveCreds(e) {
    if (e) e.preventDefault();
    setCredsErr(null); setCredsSaved(false);
    const id = clientId.trim();
    const sec = clientSecret.trim();
    if (!id.endsWith('.apps.googleusercontent.com')) {
      return setCredsErr('Client ID should end with .apps.googleusercontent.com.');
    }
    if (!sec) {
      return setCredsErr('Paste the client secret from the same OAuth client modal.');
    }
    setCredsBusy(true);
    try {
      await window.playbill.controller.command({
        action: 'youtube.setSettings',
        value:  { clientId: id, clientSecret: sec },
      });
      setClientId(''); setClientSecret('');
      setCredsSaved(true);
      setShowCreds(false);
    } catch (e2) {
      setCredsErr(String(e2.message || e2));
    } finally { setCredsBusy(false); }
  }

  return (
    <div style={{padding:'40px 60px', maxWidth:900}}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24}}>
        <h1 style={{margin:0, font:'700 32px var(--font-sans)', letterSpacing:-1, display:'flex', alignItems:'center', gap:12}}>
          <ion-icon name="logo-youtube" style={{color:'#FF0000', fontSize:38}}></ion-icon> YouTube
        </h1>
        {yt.signedIn && yt.account && (
          <div style={{display:'flex', alignItems:'center', gap:12, padding:'6px 12px',
                       background:'rgba(82,164,65,0.1)', border:'1px solid rgba(82,164,65,0.3)',
                       borderRadius:9999, fontSize:13, color:'#52a441'}}>
            {yt.account.thumbnail && <img src={yt.account.thumbnail} style={{width:24, height:24, borderRadius:'50%'}} alt="" />}
            <span>Signed in as <strong>{yt.account.title}</strong></span>
          </div>
        )}
      </div>

      {/* Section 1 — Anonymous browse status. This is the default, always-on path. */}
      <section data-zone="settings.youtube.browse" data-zone-axis="vertical"
               style={{marginBottom:32}}>
        <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:14}}>
          <h2 style={{...sectionHdr, margin:0}}>Search &amp; watch</h2>
          <div style={{display:'inline-flex', alignItems:'center', gap:8, padding:'4px 12px',
                       borderRadius:9999, background:'rgba(82,164,65,0.1)',
                       border:'1px solid rgba(82,164,65,0.3)', color:'#52a441',
                       fontSize:11, letterSpacing:0.5, textTransform:'uppercase'}}>
            <span style={{width:6, height:6, borderRadius:'50%', background:'#52a441',
                          boxShadow:'0 0 8px #52a44180'}}></span>
            Ready
          </div>
        </div>
        <p style={{color:'rgba(255,255,255,0.5)', fontSize:13, marginBottom:0, maxWidth:680}}>
          YouTube search and playback work without any sign-in or credentials.
          Anyone can search and watch immediately &mdash; no Google account, no Cloud
          project, no setup. The optional sign-in below is only needed if you want
          your subscriptions, watch later, and liked playlists on the device.
        </p>
      </section>

      {/* Section 2 — Optional sign-in. Three states: needs creds / has creds & not signed in / signed in. */}
      <section data-zone="settings.youtube.signin" data-zone-axis="vertical"
               style={{marginTop:32, paddingTop:24, borderTop:'1px solid rgba(255,255,255,0.08)'}}>
        <h2 style={sectionHdr}>Sign in to your account (optional)</h2>
        <p style={{color:'rgba(255,255,255,0.5)', fontSize:13, marginBottom:18, maxWidth:680}}>
          To bring your subscriptions, watch later, and liked playlists onto the Playbill,
          you create your own Google Cloud OAuth client (one-time, ~10&nbsp;minutes) and paste
          the Client&nbsp;ID and Client&nbsp;secret here. Each Playbill keeps its own credentials at
          file mode 0600; the values are never sent to TrailCurrent or anywhere else.
        </p>
        <p style={{color:'rgba(255,255,255,0.4)', fontSize:12, marginBottom:18}}>
          Setup guide (open on your phone/laptop): <a href="https://headwaters.local/docs/playbill-youtube-setup.html"
            target="_blank" rel="noreferrer" style={{color:'#52a441'}}>
            headwaters.local/docs/playbill-youtube-setup.html
          </a>
        </p>

        {error && (
          <div style={{padding:'12px 14px', marginBottom:18, background:'rgba(255,84,83,0.1)',
                       border:'1px solid rgba(255,84,83,0.3)', borderRadius:8,
                       color:'#ff5453', fontSize:13}}>{error}</div>
        )}
        {credsSaved && !yt.signedIn && (
          <div style={{marginBottom:14}}>
            <SuccessAlert title="Credentials saved." message="Tap Sign in to YouTube to start the device-code flow." />
          </div>
        )}

        {/* Sign-in pending: big code + URL */}
        {yt.pending && (
          <div style={{padding:'24px', marginBottom:24, background:'rgba(82,164,65,0.06)',
                       border:'1px solid rgba(82,164,65,0.3)', borderRadius:12, maxWidth:600}}>
            <div style={{fontSize:13, color:'rgba(255,255,255,0.7)', marginBottom:8}}>
              On your phone or laptop, open:
            </div>
            <div style={{font:'600 22px var(--font-mono)', color:'#fff', marginBottom:24}}>
              {yt.pending.verification_url}
            </div>
            <div style={{fontSize:13, color:'rgba(255,255,255,0.7)', marginBottom:8}}>
              And enter this code:
            </div>
            <div style={{font:'700 48px var(--font-mono)', color:'var(--tc-primary)', letterSpacing:6, marginBottom:18}}>
              {yt.pending.user_code}
            </div>
            <div style={{fontSize:12, color:'rgba(255,255,255,0.5)', marginBottom:18}}>
              Waiting for confirmation&hellip;
            </div>
            <button className="tv-btn" onClick={cancelSignIn} disabled={busy}>
              <ion-icon name="close"></ion-icon> Cancel
            </button>
          </div>
        )}

        {/* State A — no creds yet: invite them to paste, with the form behind a toggle so the default view is calm. */}
        {!yt.pending && !yt.signedIn && !yt.canSignIn && !showCreds && (
          <button className="tv-btn primary" onClick={() => setShowCreds(true)}>
            <ion-icon name="key-outline"></ion-icon> Enter Google Cloud credentials
          </button>
        )}

        {/* State A — credentials form expanded. */}
        {!yt.pending && !yt.signedIn && !yt.canSignIn && showCreds && (
          <form onSubmit={saveCreds} style={{maxWidth:600, display:'flex', flexDirection:'column', gap:14}} noValidate>
            <div>
              <label style={labelStyle}>Client ID</label>
              <input style={inputStyle}
                     type="text"
                     placeholder="…apps.googleusercontent.com"
                     value={clientId} onChange={(e) => { setClientId(e.target.value); setCredsErr(null); }}
                     autoComplete="off" spellCheck="false"
                     data-osk="text" data-osk-title="YouTube Client ID" />
            </div>
            <div>
              <label style={labelStyle}>Client secret</label>
              <input style={inputStyle}
                     type="password"
                     placeholder="GOCSPX-…"
                     value={clientSecret} onChange={(e) => { setClientSecret(e.target.value); setCredsErr(null); }}
                     autoComplete="off" spellCheck="false"
                     data-osk="text" data-osk-title="YouTube Client secret" />
            </div>
            {credsErr && <FieldError>{credsErr}</FieldError>}
            <div style={{display:'flex', gap:12}}>
              <button type="submit" className="tv-btn primary"
                      disabled={credsBusy || !clientId.trim() || !clientSecret.trim()}>
                <ion-icon name="save-outline"></ion-icon>
                {credsBusy ? 'Saving…' : 'Save credentials'}
              </button>
              <button type="button" className="tv-btn" onClick={() => {
                setShowCreds(false); setClientId(''); setClientSecret(''); setCredsErr(null);
              }} disabled={credsBusy}>
                <ion-icon name="close"></ion-icon> Cancel
              </button>
            </div>
          </form>
        )}

        {/* State B — creds present, not signed in: offer device-code sign-in + edit creds. */}
        {!yt.pending && !yt.signedIn && yt.canSignIn && (
          <div style={{display:'flex', gap:12, flexWrap:'wrap'}}>
            <button className="tv-btn primary" onClick={startSignIn} disabled={busy}>
              <ion-icon name="log-in-outline"></ion-icon>
              {busy ? 'Starting…' : 'Sign in to YouTube'}
            </button>
            <button className="tv-btn" onClick={() => setShowCreds(true)} disabled={busy}>
              <ion-icon name="key-outline"></ion-icon> Edit credentials
            </button>
          </div>
        )}

        {/* State B — edit-creds form re-opened. */}
        {!yt.pending && !yt.signedIn && yt.canSignIn && showCreds && (
          <form onSubmit={saveCreds} style={{maxWidth:600, display:'flex', flexDirection:'column', gap:14, marginTop:18}} noValidate>
            <div>
              <label style={labelStyle}>Client ID (paste to overwrite)</label>
              <input style={inputStyle}
                     type="text"
                     placeholder="…apps.googleusercontent.com"
                     value={clientId} onChange={(e) => { setClientId(e.target.value); setCredsErr(null); }}
                     autoComplete="off" spellCheck="false"
                     data-osk="text" data-osk-title="YouTube Client ID" />
            </div>
            <div>
              <label style={labelStyle}>Client secret (paste to overwrite)</label>
              <input style={inputStyle}
                     type="password"
                     placeholder="GOCSPX-…"
                     value={clientSecret} onChange={(e) => { setClientSecret(e.target.value); setCredsErr(null); }}
                     autoComplete="off" spellCheck="false"
                     data-osk="text" data-osk-title="YouTube Client secret" />
            </div>
            {credsErr && <FieldError>{credsErr}</FieldError>}
            <div style={{display:'flex', gap:12}}>
              <button type="submit" className="tv-btn primary"
                      disabled={credsBusy || !clientId.trim() || !clientSecret.trim()}>
                <ion-icon name="save-outline"></ion-icon>
                {credsBusy ? 'Saving…' : 'Save credentials'}
              </button>
              <button type="button" className="tv-btn" onClick={() => {
                setShowCreds(false); setClientId(''); setClientSecret(''); setCredsErr(null);
              }} disabled={credsBusy}>
                <ion-icon name="close"></ion-icon> Cancel
              </button>
            </div>
          </form>
        )}

        {/* State C — signed in: sign-out only. */}
        {yt.signedIn && (
          <button className="tv-btn" onClick={signOut} disabled={busy}
                  style={{background:'rgba(255,84,83,0.1)', color:'#ff5453'}}>
            <ion-icon name="log-out-outline"></ion-icon> Sign Out
          </button>
        )}
      </section>
    </div>
  );
}

// ─── Library settings: OMDb metadata API key + library root path ─────
//
// The OMDb key is optional — without it the DVD-rip flow falls back to
// manual title entry. With it, an inserted disc gets a poster + plot +
// IMDb rating auto-filled into the rip prompt.
//
// State lives on state.dvd.omdbApiKeySet (boolean). The key itself is
// never returned over IPC; the user re-pastes it to rotate. Same pattern
// as the Headwaters API key screen.

function LibraryScreen({ ctrlState }) {
  const omdbKeySet = !!(ctrlState && ctrlState.dvd && ctrlState.dvd.omdbApiKeySet);

  const [key, setKey]     = useState('');
  const [busy, setBusy]   = useState(false);
  const [saved, setSaved] = useState(false);
  const [result, setResult] = useState(null);   // {ok, kind?, message?}
  const [fieldErr, setFieldErr] = useState(null);

  // Poster-refresh state. Separate from the key-save flow so they don't
  // step on each other (different busy spinners, different result text).
  const [refreshBusy, setRefreshBusy]     = useState(false);
  const [refreshResult, setRefreshResult] = useState(null); // {attempted, downloaded, failed, skipped, total}
  const [refreshError, setRefreshError]   = useState(null);

  const sectionHdr = { font:'600 11px var(--font-sans)', letterSpacing:2,
                       textTransform:'uppercase', color:'rgba(255,255,255,0.45)',
                       margin:'0 0 14px' };
  const labelStyle = { display:'block', fontSize:12, letterSpacing:1,
                       textTransform:'uppercase', color:'rgba(255,255,255,0.6)',
                       marginBottom:6 };
  const inputStyle = { width:'100%', padding:'12px 14px', background:'rgba(255,255,255,0.05)',
                       border:'1px solid rgba(255,255,255,0.1)', borderRadius:8,
                       color:'#fff', font:'14px var(--font-sans)' };

  function validateKey(v) {
    const t = (v || '').trim();
    if (!t) return 'Paste your OMDb API key.';
    // OMDb keys are 8 hex characters. Reject obvious mistakes early so
    // the user fixes typos here instead of waiting for a 401 from OMDb.
    if (!/^[a-f0-9]{6,16}$/i.test(t)) return 'OMDb keys are 8 hex characters (request one at omdbapi.com/apikey.aspx).';
    return null;
  }

  async function saveKey(e) {
    if (e) e.preventDefault();
    setResult(null); setSaved(false);
    const err = validateKey(key);
    setFieldErr(err);
    if (err) return;
    setBusy(true);
    try {
      // Validate BEFORE persisting — a typo'd key shouldn't get saved.
      const v = await window.playbill.controller.command({
        action: 'dvd.validateOmdbKey',
        value:  { apiKey: key.trim() },
      });
      if (!v.ok) { setResult({ ok: false, kind: v.kind || 'unknown', message: v.error }); return; }
      await window.playbill.controller.command({
        action: 'dvd.setOmdbKey',
        value:  { apiKey: key.trim() },
      });
      setKey('');
      setSaved(true);
    } catch (e) {
      setResult({ ok: false, kind: 'unknown', message: String(e.message || e) });
    } finally { setBusy(false); }
  }

  async function clearKey() {
    if (!confirm('Remove the stored OMDb API key? Future disc inserts will fall back to manual title entry.')) return;
    setBusy(true); setResult(null); setSaved(false);
    try {
      await window.playbill.controller.command({ action: 'dvd.setOmdbKey', value: { apiKey: '' } });
    } catch (e) {
      setResult({ ok: false, kind: 'unknown', message: String(e.message || e) });
    } finally { setBusy(false); }
  }

  async function refreshPosters() {
    setRefreshBusy(true); setRefreshResult(null); setRefreshError(null);
    try {
      const r = await window.playbill.controller.command({ action: 'dvd.refreshPosters' });
      setRefreshResult(r);
    } catch (e) {
      setRefreshError(String(e.message || e));
    } finally { setRefreshBusy(false); }
  }

  return (
    <div style={{padding:'40px 60px', maxWidth:900}}>
      <h1 style={{margin:'0 0 8px', font:'700 32px var(--font-sans)', letterSpacing:-1}}>Library</h1>
      <p style={{color:'rgba(255,255,255,0.6)', fontSize:14, marginBottom:32, maxWidth:680}}>
        Settings for the offline media library &mdash; movies and TV ripped from inserted DVDs.
      </p>

      <section data-zone="settings.library.omdb" data-zone-axis="vertical"
               style={{marginBottom:32}}>
        <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:14}}>
          <h2 style={{...sectionHdr, margin:0}}>OMDb API key</h2>
          {omdbKeySet && (
            <div style={{display:'inline-flex', alignItems:'center', gap:8, padding:'4px 12px',
                         borderRadius:9999, background:'rgba(82,164,65,0.1)',
                         border:'1px solid rgba(82,164,65,0.3)', color:'#52a441',
                         fontSize:11, letterSpacing:0.5, textTransform:'uppercase'}}>
              <span style={{width:6, height:6, borderRadius:'50%', background:'#52a441',
                            boxShadow:'0 0 8px #52a44180'}}></span>
              Key stored
            </div>
          )}
        </div>
        <p style={{color:'rgba(255,255,255,0.5)', fontSize:13, marginBottom:18, maxWidth:680}}>
          When you insert a DVD, Playbill can look up the title's poster, year, runtime, plot,
          and IMDb rating from <a href="https://www.omdbapi.com/" target="_blank" rel="noreferrer"
            style={{color:'#52a441'}}>OMDb</a> so you don't have to type it. The free tier is 1000
          lookups/day &mdash; plenty for a personal library. Without a key the rip flow still works;
          you just enter the title and year by hand. Stored at file mode 0600 alongside the
          Headwaters API key; never returned over IPC after saving.
        </p>
        <p style={{color:'rgba(255,255,255,0.4)', fontSize:12, marginBottom:18}}>
          Request a free key: <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noreferrer"
            style={{color:'#52a441'}}>omdbapi.com/apikey.aspx</a> &mdash; takes about a minute, key arrives by email.
        </p>

        {result && !result.ok && (
          <div style={{marginBottom:14}}>
            <ErrorAlert kind={result.kind} title="OMDb key validation failed" message={result.message} />
          </div>
        )}
        {saved && (
          <div style={{marginBottom:14}}>
            <SuccessAlert title="OMDb key saved." message="Future disc inserts will auto-fill metadata." />
          </div>
        )}

        <form onSubmit={saveKey} style={{maxWidth:600, display:'flex', flexDirection:'column', gap:14}} noValidate>
          <div>
            <label style={labelStyle}>API key {omdbKeySet && '(currently set; paste again to rotate)'}</label>
            <input style={{...inputStyle,
                            border: `1px solid ${fieldErr ? 'rgba(255,84,83,0.6)' : 'rgba(255,255,255,0.1)'}`}}
                   type="password"
                   placeholder={omdbKeySet ? '••••••••' : '8-character hex key'}
                   value={key} onChange={(e) => { setKey(e.target.value); setFieldErr(null); }}
                   autoComplete="off" spellCheck="false"
                   data-osk="text" data-osk-title="OMDb API key" />
            <FieldError>{fieldErr}</FieldError>
          </div>
          <div style={{display:'flex', gap:12}}>
            <button type="submit" className="tv-btn primary" disabled={busy || !key.trim()}>
              <ion-icon name="save-outline"></ion-icon>
              {busy ? 'Validating…' : 'Save key'}
            </button>
            {omdbKeySet && (
              <button type="button" className="tv-btn" onClick={clearKey} disabled={busy}
                      style={{background:'rgba(255,84,83,0.1)', color:'#ff5453'}}>
                <ion-icon name="trash-outline"></ion-icon> Remove key
              </button>
            )}
          </div>
        </form>
      </section>

      <section data-zone="settings.library.posters" data-zone-axis="vertical"
               style={{marginTop:32, paddingTop:24, borderTop:'1px solid rgba(255,255,255,0.08)'}}>
        <h2 style={sectionHdr}>Poster cache</h2>
        <p style={{color:'rgba(255,255,255,0.5)', fontSize:13, marginBottom:18, maxWidth:680}}>
          Posters are downloaded to <code style={{color:'rgba(255,255,255,0.7)'}}>&lt;Title&gt;.jpg</code>
          alongside each ripped <code style={{color:'rgba(255,255,255,0.7)'}}>.mkv</code> so the
          Library renders posters with no internet. If a rip happened off-grid, the poster file
          is missing &mdash; click <em>Refresh posters</em> after reconnecting to backfill them all
          from each title's stored OMDb URL.
        </p>

        {refreshError && (
          <div style={{marginBottom:14}}>
            <ErrorAlert kind="unknown" title="Poster refresh failed" message={refreshError} />
          </div>
        )}
        {refreshResult && (
          <div style={{marginBottom:14}}>
            <SuccessAlert
              title="Poster refresh complete."
              message={`Scanned ${refreshResult.total} title${refreshResult.total === 1 ? '' : 's'}: `
                     + `${refreshResult.downloaded} downloaded, `
                     + `${refreshResult.skipped} already cached, `
                     + `${refreshResult.failed} failed.`}
            />
          </div>
        )}

        <button type="button" className="tv-btn" onClick={refreshPosters} disabled={refreshBusy}>
          <ion-icon name={refreshBusy ? 'sync-outline' : 'images-outline'}
                    style={{animation: refreshBusy ? 'spin 1s linear infinite' : 'none'}}></ion-icon>
          {refreshBusy ? 'Refreshing…' : 'Refresh posters'}
        </button>
      </section>

      <section data-zone="settings.library.location" data-zone-axis="vertical"
               style={{marginTop:32, paddingTop:24, borderTop:'1px solid rgba(255,255,255,0.08)'}}>
        <h2 style={sectionHdr}>Library location</h2>
        <p style={{color:'rgba(255,255,255,0.5)', fontSize:13, marginBottom:14, maxWidth:680}}>
          Ripped titles are written to:
        </p>
        <code style={{display:'block', padding:'12px 14px', background:'rgba(255,255,255,0.03)',
                       border:'1px dashed rgba(255,255,255,0.1)', borderRadius:8,
                       color:'rgba(255,255,255,0.7)', fontSize:13, maxWidth:600}}>
          ~/Playbill/&#123;Movies,Shows&#125;/&lt;Title&gt;/&lt;Title&gt;.mkv
        </code>
        <p style={{color:'rgba(255,255,255,0.4)', fontSize:12, marginTop:10, maxWidth:680}}>
          Each title is a folder with a <code style={{color:'rgba(255,255,255,0.6)'}}>.mkv</code> and a
          metadata <code style={{color:'rgba(255,255,255,0.6)'}}>.json</code> sidecar. Move, back up,
          or delete files directly &mdash; the library refreshes the next time you open it.
        </p>
      </section>
    </div>
  );
}

// ─── Audio settings: per-source loudness trim + normalize toggle ─────
//
// FM radio is mastered way hotter than a DVD; YouTube is hotter than both
// Live TV in turn. Without per-source compensation the jump between them
// is jarring — these sliders let the user offset each source by ±dB so
// switching between Library, Radio, YouTube, etc. lands at a similar
// perceived loudness. The "Real-time loudness normalization" toggle adds
// dynaudnorm inside mpv to even out within-source dynamic range too.
//
// Stored under settings.audio (validated by the controller's schema):
//   { normalize: bool, perSourceTrimDb: { library, livetv, youtube,
//     radioFm, radioAm, cast } }

const AUDIO_SOURCES = [
  { key: 'library', label: 'Library',  hint: 'DVDs, local files, Plex',         icon: 'film-outline' },
  { key: 'livetv',  label: 'Live TV',  hint: 'OTA / DVB tuner',                 icon: 'tv-outline' },
  { key: 'youtube', label: 'YouTube',  hint: 'Streamed YouTube videos',         icon: 'logo-youtube' },
  { key: 'radioFm', label: 'FM Radio', hint: 'Broadcast FM (heavily compressed)', icon: 'radio-outline' },
  { key: 'radioAm', label: 'AM Radio', hint: 'Broadcast AM',                    icon: 'radio-outline' },
  { key: 'cast',    label: 'AirPlay',  hint: 'iPhone / iPad mirror & cast',     icon: 'phone-portrait-outline' },
];

const AUDIO_DEFAULTS = {
  library: 0, livetv: -3, youtube: -2, radioFm: -8, radioAm: 0, cast: 0,
};

function TrimSlider({ value, onChange, disabled }) {
  // -24 .. +12 dB matches the schema's range. Step 0.5 dB for fine tuning.
  return (
    <div style={{display:'flex', alignItems:'center', gap:14, width:'100%'}}>
      <input type="range" min={-24} max={12} step={0.5} value={value}
             onChange={(e) => onChange(parseFloat(e.target.value))}
             disabled={disabled}
             style={{flex:1, accentColor:'var(--tc-primary)'}} />
      <div style={{minWidth:64, textAlign:'right', fontFamily:'var(--font-mono)',
                    fontSize:13, color: value === 0 ? 'rgba(255,255,255,0.6)' : '#fff',
                    fontWeight: value === 0 ? 400 : 600}}>
        {value > 0 ? '+' : ''}{value.toFixed(1)} dB
      </div>
    </div>
  );
}

function AudioScreen({ ctrlState }) {
  const audio = (ctrlState && ctrlState.settings && ctrlState.settings.audio) || {};
  const initialTrims = { ...AUDIO_DEFAULTS, ...(audio.perSourceTrimDb || {}) };
  const initialNormalize = audio.normalize !== false;

  const [trims, setTrims]         = useState(initialTrims);
  const [normalize, setNormalize] = useState(initialNormalize);
  const [busy, setBusy]           = useState(false);
  const [savedAt, setSavedAt]     = useState(0);
  const [error, setError]         = useState(null);

  // Keep local state in sync if settings change from another path (e.g.
  // PWA edits, settings.patch via MQTT). Without this the slider stays
  // stuck at whatever the user saw on mount.
  useEffect(() => {
    setTrims({ ...AUDIO_DEFAULTS, ...(audio.perSourceTrimDb || {}) });
    setNormalize(audio.normalize !== false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrlState && ctrlState.settings && JSON.stringify(ctrlState.settings.audio)]);

  async function save(partial) {
    setBusy(true); setError(null);
    try {
      await window.playbill.controller.command({
        action: 'settings.patch',
        value:  { audio: { normalize, perSourceTrimDb: trims, ...partial } },
      });
      setSavedAt(Date.now());
    } catch (e) {
      setError(String(e.message || e));
    } finally { setBusy(false); }
  }

  function setTrim(key, v) {
    const next = { ...trims, [key]: v };
    setTrims(next);
    // Debounce-ish: write on slider release only. We rely on onChange
    // updating local state for snappy UI; the save fires from a separate
    // commit button below to avoid spamming the IPC bus while dragging.
  }

  async function commit() {
    await save({});
  }

  function resetAll() {
    setTrims({ ...AUDIO_DEFAULTS });
    setNormalize(true);
  }

  async function resetAndSave() {
    setTrims({ ...AUDIO_DEFAULTS });
    setNormalize(true);
    setBusy(true); setError(null);
    try {
      await window.playbill.controller.command({
        action: 'settings.patch',
        value:  { audio: { normalize: true, perSourceTrimDb: { ...AUDIO_DEFAULTS } } },
      });
      setSavedAt(Date.now());
    } catch (e) {
      setError(String(e.message || e));
    } finally { setBusy(false); }
  }

  const sectionHdr = { font:'600 11px var(--font-sans)', letterSpacing:2,
                       textTransform:'uppercase', color:'rgba(255,255,255,0.45)',
                       margin:'0 0 14px' };

  // Detect unsaved changes vs the snapshot from ctrlState.
  const dirty =
    JSON.stringify(trims) !== JSON.stringify({ ...AUDIO_DEFAULTS, ...(audio.perSourceTrimDb || {}) }) ||
    normalize !== (audio.normalize !== false);

  return (
    <div style={{padding:'40px 60px', maxWidth:900}}>
      <h1 style={{margin:'0 0 8px', font:'700 32px var(--font-sans)', letterSpacing:-1}}>Audio</h1>
      <p style={{color:'rgba(255,255,255,0.6)', fontSize:14, marginBottom:32, maxWidth:680}}>
        Balance the volume of each source so switching between Library, Radio, YouTube and the
        rest isn&rsquo;t jarring. Trims are applied <em>before</em> the system master volume —
        the volume bar still goes 0&ndash;100%, but the level it represents is consistent
        across sources.
      </p>

      {error && (
        <div style={{marginBottom:14}}>
          <ErrorAlert kind="unknown" title="Could not save" message={error} />
        </div>
      )}
      {savedAt !== 0 && !dirty && !error && (
        <div style={{marginBottom:14}}>
          <SuccessAlert title="Saved." message="Trim values apply to the next track / station you start." />
        </div>
      )}

      <section data-zone="settings.audio.normalize" data-zone-axis="vertical"
               style={{marginBottom:28}}>
        <h2 style={sectionHdr}>Loudness normalization</h2>
        <label style={{display:'flex', alignItems:'flex-start', gap:14, padding:'14px 16px',
                       background:'rgba(255,255,255,0.03)',
                       border:'1px solid rgba(255,255,255,0.08)', borderRadius:8,
                       cursor:'pointer', maxWidth:680}}>
          <input type="checkbox" checked={normalize}
                 onChange={(e) => setNormalize(e.target.checked)}
                 style={{marginTop:3, accentColor:'var(--tc-primary)', transform:'scale(1.2)'}} />
          <div>
            <div style={{font:'600 14px var(--font-sans)', marginBottom:4}}>Real-time loudness normalization</div>
            <div style={{fontSize:12, color:'rgba(255,255,255,0.6)', lineHeight:1.5}}>
              Keeps quiet dialogue and loud explosions at a similar perceived loudness within a single
              video. Applied to Library, Live TV, and YouTube via the player&rsquo;s
              <code style={{color:'rgba(255,255,255,0.75)', background:'rgba(255,255,255,0.05)',
                              padding:'1px 5px', borderRadius:3, margin:'0 4px',
                              fontFamily:'var(--font-mono)', fontSize:11}}>dynaudnorm</code>
              filter. Turn off to hear source material untouched.
            </div>
          </div>
        </label>
      </section>

      <section data-zone="settings.audio.trim" data-zone-axis="vertical">
        <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:14}}>
          <h2 style={{...sectionHdr, margin:0}}>Per-source trim</h2>
          <button type="button" onClick={resetAndSave} disabled={busy}
                  className="tv-btn"
                  style={{fontSize:12, padding:'6px 12px',
                          background:'rgba(255,255,255,0.04)',
                          color:'rgba(255,255,255,0.7)'}}>
            <ion-icon name="refresh-outline"></ion-icon> Restore defaults
          </button>
        </div>
        <p style={{color:'rgba(255,255,255,0.5)', fontSize:13, marginBottom:20, maxWidth:680}}>
          Each slider offsets that source by &plusmn;dB. <strong>0&nbsp;dB</strong> = no change,
          <strong>&minus;6&nbsp;dB</strong> &approx; half as loud, <strong>+6&nbsp;dB</strong> &approx; twice as loud.
          Negative is usually what you need &mdash; broadcast FM and YouTube tend to ship hotter than
          DVDs and Live TV.
        </p>

        <div style={{display:'flex', flexDirection:'column', gap:14, maxWidth:680}}>
          {AUDIO_SOURCES.map(({ key, label, hint, icon }) => (
            <div key={key}
                 style={{padding:'14px 16px', background:'rgba(255,255,255,0.03)',
                          border:'1px solid rgba(255,255,255,0.08)', borderRadius:8}}>
              <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:10}}>
                <ion-icon name={icon} style={{fontSize:18, color:'var(--tc-primary)'}}></ion-icon>
                <div style={{font:'600 14px var(--font-sans)'}}>{label}</div>
                <div style={{flex:1}} />
                <div style={{fontSize:11, color:'rgba(255,255,255,0.45)'}}>{hint}</div>
              </div>
              <TrimSlider value={trims[key] ?? 0}
                          onChange={(v) => setTrim(key, v)}
                          disabled={busy} />
            </div>
          ))}
        </div>

        <div style={{display:'flex', gap:12, marginTop:24}}>
          <button type="button" onClick={commit} disabled={busy || !dirty}
                  className="tv-btn primary">
            <ion-icon name="save-outline"></ion-icon>
            {busy ? 'Saving…' : (dirty ? 'Save changes' : 'Saved')}
          </button>
          {dirty && (
            <button type="button" onClick={resetAll} disabled={busy} className="tv-btn">
              <ion-icon name="arrow-undo-outline"></ion-icon> Discard
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

Object.assign(window, { SettingsView });
