/* Rig View — outdoor cameras + vehicle systems overlay on TV */

function RigView({ focus }) {
  const D = window.TV_DATA;
  return (
    <div className="rig-view">
      <div className="view-hdr">
        <h2>Rig View</h2>
        <p>Exterior cameras + live vehicle systems</p>
      </div>

      <div className="rig-grid" style={{marginTop: 18}}>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16}}>
          {D.cams.map((c, i) => (
            <div key={c.id} className={'cam-tile' + (focus.row === 'cams' && focus.col === i ? ' focused' : '')}>
              <div className="feed">
                {/* subtle scan pattern */}
                <svg width="100%" height="100%" style={{position:'absolute', inset:0, opacity: 0.3}}>
                  <defs>
                    <pattern id={'scan-' + c.id} width="4" height="4" patternUnits="userSpaceOnUse">
                      <rect width="4" height="2" fill="transparent"/>
                      <rect y="2" width="4" height="2" fill="rgba(82,164,65,0.1)"/>
                    </pattern>
                  </defs>
                  <rect width="100%" height="100%" fill={`url(#scan-${c.id})`}/>
                </svg>
                {/* HUD reticle for front cam */}
                {c.label === 'FRONT' && (
                  <svg style={{position:'absolute', inset:0}} width="100%" height="100%">
                    <g stroke="var(--tc-primary)" strokeWidth="1" fill="none" opacity="0.6">
                      <line x1="50%" y1="40%" x2="50%" y2="60%" />
                      <line x1="40%" y1="50%" x2="60%" y2="50%" />
                      <circle cx="50%" cy="50%" r="40" />
                      <rect x="25%" y="30%" width="50%" height="40%" strokeDasharray="6 6"/>
                    </g>
                    <text x="30%" y="28%" fill="var(--tc-primary)" fontSize="10" fontFamily="var(--font-mono)">OBJ-DETECT: 2 VEHICLES</text>
                  </svg>
                )}
              </div>
              <div className="label">
                <span className="rec"></span>
                {c.label}
              </div>
              <div style={{position:'absolute', bottom:12, left:12, color:'rgba(255,255,255,0.6)', fontSize:11, fontFamily:'var(--font-mono)', zIndex: 3}}>
                {c.title}
              </div>
              <div style={{position:'absolute', bottom:12, right:12, color:'rgba(255,255,255,0.4)', fontSize:10, fontFamily:'var(--font-mono)', zIndex: 3}}>
                {new Date().toISOString().slice(0,19)}
              </div>
            </div>
          ))}
        </div>

        <div style={{display:'flex', flexDirection:'column', gap: 16}}>
          <div className="rig-panel">
            <h3>Battery Bank</h3>
            <div className="rig-row"><span className="k">State of Charge</span><span className="v ok">87%</span></div>
            <div className="rig-row"><span className="k">Voltage</span><span className="v">13.4 V</span></div>
            <div className="rig-row"><span className="k">Current</span><span className="v ok">+12.4 A</span></div>
            <div className="rig-row"><span className="k">Solar In</span><span className="v" style={{color:'var(--tc-solar)'}}>412 W</span></div>
            <div className="rig-row"><span className="k">Shore</span><span className="v" style={{color: 'rgba(255,255,255,0.3)'}}>—</span></div>
          </div>

          <div className="rig-panel">
            <h3>Climate</h3>
            <div className="rig-row"><span className="k">Interior</span><span className="v ok">68°F</span></div>
            <div className="rig-row"><span className="k">Outside</span><span className="v">82°F</span></div>
            <div className="rig-row"><span className="k">HVAC Mode</span><span className="v">Cool</span></div>
            <div className="rig-row"><span className="k">Fan</span><span className="v">Auto</span></div>
          </div>

          <div className="rig-panel">
            <h3>Tanks</h3>
            <div className="rig-row"><span className="k">Fresh</span><span className="v ok">74%</span></div>
            <div className="rig-row"><span className="k">Grey</span><span className="v warn">62%</span></div>
            <div className="rig-row"><span className="k">Black</span><span className="v">31%</span></div>
            <div className="rig-row"><span className="k">Propane</span><span className="v ok">88%</span></div>
          </div>

          <div className="rig-panel">
            <h3>Security</h3>
            <div className="rig-row"><span className="k">Motion</span><span className="v ok">Clear</span></div>
            <div className="rig-row"><span className="k">Recording</span><span className="v" style={{color: 'var(--tc-danger)'}}>● All 4 cams</span></div>
            <div className="rig-row"><span className="k">Geofence</span><span className="v ok">Inside</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { RigView });
