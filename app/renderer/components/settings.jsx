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

function ConnectionForm({ initial, onSave, busy }) {
  const [brokerUrl, setBrokerUrl] = useState(initial?.brokerUrl || '');
  const [username,  setUsername]  = useState(initial?.username  || '');
  const [password,  setPassword]  = useState('');
  const [tlsHost,   setTlsHost]   = useState(initial?.tlsCertHostname || '');
  const [caCert,    setCaCert]    = useState('');
  const [error,     setError]     = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await onSave({
        brokerUrl, username, password,
        tlsCertHostname: tlsHost || null,
        caCertProvided: !!caCert || !!initial?.caCertProvided,
        ca: caCert || undefined,
      });
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const labelStyle = { display:'block', fontSize:12, letterSpacing:1,
                       textTransform:'uppercase', color:'rgba(255,255,255,0.6)',
                       marginBottom:6 };
  const inputStyle = { width:'100%', padding:'12px 14px', background:'rgba(255,255,255,0.05)',
                       border:'1px solid rgba(255,255,255,0.1)', borderRadius:8,
                       color:'#fff', font:'14px var(--font-sans)' };

  return (
    <form onSubmit={submit} style={{maxWidth:600, display:'flex', flexDirection:'column', gap:18}}>
      <div>
        <label style={labelStyle}>Broker hostname</label>
        <input style={inputStyle} type="text" placeholder="headwaters.local"
               value={brokerUrl} onChange={(e) => setBrokerUrl(e.target.value)} required />
        <div style={{fontSize:11, color:'rgba(255,255,255,0.4)', marginTop:6}}>
          Always TLS (mqtts://). Port defaults to 8883 — append <code>:&lt;port&gt;</code> only if your broker uses a different one.
        </div>
      </div>
      <div>
        <label style={labelStyle}>Username</label>
        <input style={inputStyle} type="text" placeholder="rig MQTT username"
               value={username} onChange={(e) => setUsername(e.target.value)} required />
      </div>
      <div>
        <label style={labelStyle}>Password {initial && !password && '(leave blank to keep current)'}</label>
        <input style={inputStyle} type="password"
               placeholder={initial ? '••••••••' : 'rig MQTT password'}
               value={password} onChange={(e) => setPassword(e.target.value)}
               required={!initial} />
      </div>
      <div>
        <label style={labelStyle}>TLS Cert Hostname (optional)</label>
        <input style={inputStyle} type="text"
               placeholder="e.g. mosquitto — only if cert hostname differs from broker URL"
               value={tlsHost} onChange={(e) => setTlsHost(e.target.value)} />
      </div>
      <div>
        <label style={labelStyle}>CA Certificate (PEM) {initial?.caCertProvided && '(currently set)'}</label>
        <textarea style={{...inputStyle, minHeight:120, fontFamily:'var(--font-mono)', fontSize:12}}
                  placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                  value={caCert} onChange={(e) => setCaCert(e.target.value)} />
      </div>
      {error && (
        <div style={{padding:'12px 14px', background:'rgba(255,84,83,0.1)',
                     border:'1px solid rgba(255,84,83,0.3)', borderRadius:8,
                     color:'#ff5453', fontSize:13}}>
          {error}
        </div>
      )}
      <div style={{display:'flex', gap:12}}>
        <button type="submit" className="tv-btn primary" disabled={busy}>
          <ion-icon name="save-outline"></ion-icon>
          {busy ? 'Saving…' : 'Save & Connect'}
        </button>
      </div>
    </form>
  );
}

function ConnectionScreen({ ctrlState }) {
  const [conn, setConn] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cur = await window.playbill.controller.command({ action: 'connection.get' });
        setConn(cur);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, []);

  const onSave = async ({ brokerUrl, username, password, tlsCertHostname, caCertProvided, ca }) => {
    setBusy(true);
    try {
      // 1. Save the cert first (if a new one was provided) so caCertProvided
      //    is true by the time we save the connection.
      if (ca && ca.trim()) {
        await window.playbill.controller.command({ action: 'connection.setCa', value: ca });
      }
      // 2. If user left password blank and we have an existing connection,
      //    we need to keep the old password — but the controller doesn't
      //    return it (security). For now, password is required when blank
      //    means "you must re-enter it". A future improvement: a separate
      //    "rotate password only" command. For now, force re-entry.
      if (!password && !conn) {
        throw new Error('password required on first setup');
      }
      const value = {
        brokerUrl, username,
        password: password || (conn?.brokerUrl === brokerUrl ? '__keep__' : password),
        tlsCertHostname: tlsCertHostname || null,
        caCertProvided: !!ca || !!conn?.caCertProvided,
      };
      // Reject the placeholder; we don't actually have a "keep current password" path yet.
      if (value.password === '__keep__') {
        throw new Error('Re-enter the password to save changes (password retention not implemented yet)');
      }
      await window.playbill.controller.command({ action: 'connection.set', value });
      // Refresh display
      const cur = await window.playbill.controller.command({ action: 'connection.get' });
      setConn(cur);
    } finally {
      setBusy(false);
    }
  };

  const onForget = async () => {
    if (!confirm('Forget MQTT credentials? Playbill will return to the unconfigured state.')) return;
    setBusy(true);
    try {
      await window.playbill.controller.command({ action: 'connection.clear' });
      setConn(null);
    } finally { setBusy(false); }
  };

  return (
    <div style={{padding:'40px 60px', maxWidth:900}}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24}}>
        <h1 style={{margin:0, font:'700 32px var(--font-sans)', letterSpacing:-1}}>Connection</h1>
        <ConnectionStatusPill
          status={ctrlState?.connection?.status || 'unconfigured'}
          lastError={ctrlState?.connection?.lastError}
        />
      </div>
      <p style={{color:'rgba(255,255,255,0.6)', fontSize:14, marginBottom:32, maxWidth:680}}>
        TrailCurrent uses a single MQTT broker per rig (typically running on Headwaters) for
        device-to-device communication. Enter the broker address and your rig's MQTT credentials
        to let this Playbill receive remote commands and publish what's playing.
      </p>
      {loading
        ? <div style={{color:'rgba(255,255,255,0.4)'}}>Loading current configuration…</div>
        : <ConnectionForm initial={conn} onSave={onSave} busy={busy} />}
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
                          font:'14px var(--font-sans)'}} />
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
  const [tab, setTab] = useState('connection');

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
    { id: 'connection', label: 'Connection', icon: 'cloud-outline' },
    { id: 'device',     label: 'Device',     icon: 'hardware-chip-outline' },
    { id: 'youtube',    label: 'YouTube',    icon: 'logo-youtube' },
    { id: 'headwaters', label: 'Headwaters', icon: 'water-outline' },
    // Phase 2+: { id: 'sources', label: 'Sources', icon: 'apps-outline' },
    // Phase 2+: { id: 'display', label: 'Display', icon: 'color-palette-outline' },
    // Phase 2+: { id: 'about',   label: 'About',   icon: 'information-circle-outline' },
  ];

  return (
    <div style={{position:'absolute', inset:0, display:'flex'}}>
      <div style={{width:240, padding:'80px 0 0', borderRight:'1px solid rgba(255,255,255,0.06)',
                    background:'rgba(0,0,0,0.2)', flexShrink:0}}>
        <div style={{padding:'0 24px 16px', font:'700 11px var(--font-sans)',
                       letterSpacing:2, color:'rgba(255,255,255,0.4)', textTransform:'uppercase'}}>
          Settings
        </div>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
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
      <div style={{flex:1, overflow:'auto'}}>
        {tab === 'connection' && <ConnectionScreen ctrlState={ctrlState} />}
        {tab === 'device'     && <DeviceScreen     ctrlState={ctrlState} />}
        {tab === 'youtube'    && <YoutubeScreen    ctrlState={ctrlState} />}
        {tab === 'headwaters' && <HeadwatersScreen ctrlState={ctrlState} />}
      </div>
    </div>
  );
}

// ─── YouTube settings: clientId/secret + sign-in device flow ─────────

function YoutubeScreen({ ctrlState }) {
  const yt = (ctrlState && ctrlState.youtube) || {};
  const [clientId, setClientId]         = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy]                 = useState(false);
  const [error, setError]               = useState(null);
  const [signInResult, setSignInResult] = useState(null);

  // When the controller reports clientId already present, prefill the field
  // (the secret is intentionally never returned so it stays blank).
  useEffect(() => {
    (async () => {
      try {
        const s = await window.playbill.controller.command({ action: 'youtube.getSettings' });
        if (s && s.clientId) setClientId(s.clientId);
      } catch (_) {}
    })();
  }, []);

  async function saveSettings(e) {
    if (e) e.preventDefault();
    setError(null); setBusy(true);
    try {
      const value = {};
      if (clientId.trim()) value.clientId = clientId.trim();
      if (clientSecret.trim()) value.clientSecret = clientSecret.trim();
      if (!Object.keys(value).length) { setBusy(false); return; }
      await window.playbill.controller.command({ action: 'youtube.setSettings', value });
      setClientSecret('');
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

  async function startSignIn() {
    setError(null); setBusy(true); setSignInResult(null);
    try {
      const r = await window.playbill.controller.command({ action: 'youtube.signInStart' });
      setSignInResult(r);
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

  async function cancelSignIn() {
    setBusy(true);
    try { await window.playbill.controller.command({ action: 'youtube.signInCancel' }); }
    finally { setBusy(false); setSignInResult(null); }
  }

  async function signOut() {
    if (!confirm('Sign out of YouTube?')) return;
    setBusy(true);
    try { await window.playbill.controller.command({ action: 'youtube.signOut' }); }
    catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

  const labelStyle = { display:'block', fontSize:12, letterSpacing:1,
                       textTransform:'uppercase', color:'rgba(255,255,255,0.6)',
                       marginBottom:6 };
  const inputStyle = { width:'100%', padding:'12px 14px', background:'rgba(255,255,255,0.05)',
                       border:'1px solid rgba(255,255,255,0.1)', borderRadius:8,
                       color:'#fff', font:'14px var(--font-sans)' };

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

      <p style={{color:'rgba(255,255,255,0.6)', fontSize:14, marginBottom:24, maxWidth:680}}>
        Personalized YouTube features (subscriptions, playlists, watch later) require Google OAuth credentials.
        Create an OAuth client of type <em>TVs and Limited Input devices</em> in
        Google Cloud Console (no review required for read-only YouTube scope) and paste the credentials below.
      </p>

      {error && (
        <div style={{padding:'12px 14px', marginBottom:18, background:'rgba(255,84,83,0.1)',
                     border:'1px solid rgba(255,84,83,0.3)', borderRadius:8,
                     color:'#ff5453', fontSize:13}}>{error}</div>
      )}

      {/* Sign-in pending: big code + URL */}
      {yt.pending && (
        <div style={{padding:'24px', marginBottom:24, background:'rgba(82,164,65,0.06)',
                     border:'1px solid rgba(82,164,65,0.3)', borderRadius:12}}>
          <div style={{fontSize:13, color:'rgba(255,255,255,0.7)', marginBottom:8}}>
            On your phone or laptop, open:
          </div>
          <div style={{font:'600 18px var(--font-mono)', color:'#fff', marginBottom:18}}>
            {yt.pending.verification_url}
          </div>
          <div style={{fontSize:13, color:'rgba(255,255,255,0.7)', marginBottom:8}}>
            And enter this code:
          </div>
          <div style={{font:'700 48px var(--font-mono)', color:'var(--tc-primary)', letterSpacing:6, marginBottom:18}}>
            {yt.pending.user_code}
          </div>
          <button className="tv-btn" onClick={cancelSignIn} disabled={busy}>
            <ion-icon name="close"></ion-icon> Cancel
          </button>
        </div>
      )}

      {/* Credentials form */}
      <form onSubmit={saveSettings} style={{maxWidth:600, display:'flex', flexDirection:'column', gap:18, marginBottom:32}}>
        <div>
          <label style={labelStyle}>Client ID</label>
          <input style={inputStyle} type="text"
                 placeholder="123456789-abc...apps.googleusercontent.com"
                 value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Client Secret {yt.clientSecretSet && '(currently set; leave blank to keep)'}</label>
          <input style={inputStyle} type="password"
                 placeholder={yt.clientSecretSet ? '••••••••' : 'GOCSPX-…'}
                 value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
        </div>
        <div>
          <button type="submit" className="tv-btn primary" disabled={busy}>
            <ion-icon name="save-outline"></ion-icon>
            Save credentials
          </button>
        </div>
      </form>

      {/* Sign-in actions */}
      {yt.configured && !yt.signedIn && !yt.pending && (
        <button className="tv-btn primary" onClick={startSignIn} disabled={busy}>
          <ion-icon name="log-in-outline"></ion-icon>
          {busy ? 'Starting…' : 'Sign in to YouTube'}
        </button>
      )}
      {yt.signedIn && (
        <button className="tv-btn" onClick={signOut} disabled={busy}
                style={{background:'rgba(255,84,83,0.1)', color:'#ff5453'}}>
          <ion-icon name="log-out-outline"></ion-icon> Sign Out
        </button>
      )}
    </div>
  );
}

// ─── Headwaters API key ──────────────────────────────────────────────

function HeadwatersScreen({ ctrlState }) {
  const apiKeySet = !!(ctrlState && ctrlState.headwaters && ctrlState.headwaters.apiKeySet);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);
  const [saved, setSaved]   = useState(false);

  async function save(e) {
    if (e) e.preventDefault();
    setError(null); setSaved(false); setBusy(true);
    try {
      if (!apiKey.trim()) throw new Error('Enter an API key');
      await window.playbill.controller.command({
        action: 'headwaters.setSettings',
        value:  { apiKey: apiKey.trim() },
      });
      setApiKey('');
      setSaved(true);
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

  async function clear() {
    if (!confirm('Remove the stored Headwaters API key?')) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await window.playbill.controller.command({ action: 'headwaters.clear' });
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

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
        {apiKeySet && (
          <div style={{display:'inline-flex', alignItems:'center', gap:8, padding:'4px 12px',
                       borderRadius:9999, background:'rgba(82,164,65,0.1)',
                       border:'1px solid rgba(82,164,65,0.3)', color:'#52a441',
                       fontSize:12, letterSpacing:0.5, textTransform:'uppercase'}}>
            <span style={{width:8, height:8, borderRadius:'50%', background:'#52a441',
                          boxShadow:'0 0 10px #52a44180'}}></span>
            Key stored
          </div>
        )}
      </div>
      <p style={{color:'rgba(255,255,255,0.6)', fontSize:14, marginBottom:32, maxWidth:680}}>
        API key used to authenticate calls to the Headwaters HTTP APIs. Stored on this
        Playbill at file mode 0600 and never returned over IPC after saving — paste it
        again to rotate.
      </p>

      {error && (
        <div style={{padding:'12px 14px', marginBottom:18, background:'rgba(255,84,83,0.1)',
                     border:'1px solid rgba(255,84,83,0.3)', borderRadius:8,
                     color:'#ff5453', fontSize:13}}>{error}</div>
      )}
      {saved && (
        <div style={{padding:'12px 14px', marginBottom:18, background:'rgba(82,164,65,0.1)',
                     border:'1px solid rgba(82,164,65,0.3)', borderRadius:8,
                     color:'#52a441', fontSize:13}}>API key saved.</div>
      )}

      <form onSubmit={save} style={{maxWidth:600, display:'flex', flexDirection:'column', gap:18}}>
        <div>
          <label style={labelStyle}>API Key {apiKeySet && '(currently set; leave blank to keep)'}</label>
          <input style={inputStyle} type="password"
                 placeholder={apiKeySet ? '••••••••' : 'paste Headwaters API key'}
                 value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                 autoComplete="off" spellCheck="false" />
        </div>
        <div style={{display:'flex', gap:12}}>
          <button type="submit" className="tv-btn primary" disabled={busy || !apiKey.trim()}>
            <ion-icon name="save-outline"></ion-icon>
            {busy ? 'Saving…' : 'Save API key'}
          </button>
          {apiKeySet && (
            <button type="button" className="tv-btn" onClick={clear} disabled={busy}
                    style={{background:'rgba(255,84,83,0.1)', color:'#ff5453'}}>
              <ion-icon name="trash-outline"></ion-icon> Remove
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

Object.assign(window, { SettingsView });
