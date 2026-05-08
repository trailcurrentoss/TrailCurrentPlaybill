/* Live TV / antenna EPG grid */

function LiveView({ focus }) {
  const D = window.TV_DATA;

  return (
    <div className="live-view">
      <div className="view-hdr" style={{display:'flex', justifyContent:'space-between', alignItems:'flex-end'}}>
        <div>
          <h2>Live TV</h2>
          <p>OTA Antenna • 6 channels locked • Strong signal</p>
        </div>
        <div style={{display:'flex', gap:8}}>
          <button className={'tv-btn' + (focus.row === 'live-ctrl' && focus.col === 0 ? ' focused' : '')}>
            <ion-icon name="refresh-outline"></ion-icon> Rescan
          </button>
          <button className={'tv-btn' + (focus.row === 'live-ctrl' && focus.col === 1 ? ' focused' : '')}>
            <ion-icon name="radio-outline"></ion-icon> Signal
          </button>
        </div>
      </div>

      <div className="epg-grid" style={{marginTop: 18}}>
        <div className="epg-corner">Channel</div>
        <div className="epg-time-header">
          <span>8:00 PM</span><span>8:30 PM</span><span>9:00 PM</span><span>9:30 PM</span>
          <span>10:00 PM</span><span>10:30 PM</span>
        </div>

        {D.channels.map((ch, chIdx) => (
          <React.Fragment key={ch.num}>
            <div className="epg-ch">
              <div>
                <div className="num">{ch.num}</div>
                <div className="net">{ch.net}</div>
              </div>
              <div>
                <div className="name">{ch.name}</div>
              </div>
            </div>
            <div className="epg-shows">
              {ch.shows.map((sh, shIdx) => (
                <div
                  key={shIdx}
                  className={
                    'epg-show' +
                    (sh.live ? ' live' : '') +
                    (focus.row === 'epg' && focus.rowY === chIdx && focus.col === shIdx ? ' focused' : '')
                  }
                  style={{ minWidth: sh.title.length > 16 ? 280 : 200 }}
                >
                  <div className="time">{sh.time} {sh.live && '• LIVE'}</div>
                  <div className="t">{sh.title}</div>
                </div>
              ))}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { LiveView });
