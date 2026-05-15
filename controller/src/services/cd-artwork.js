/* Cover-art downloader — pulls a Cover Art Archive front-image down to
   a local cover.jpg next to the ripped album so the library keeps
   rendering thumbnails when the rig is off-grid.

   Best-effort by design — failing to fetch artwork must never block a
   rip. Mirrors dvd-poster.js: same redirect handling, same atomic
   rename, same MAX_BYTES guard. The only differences:
     • target is always <album_dir>/cover.jpg
     • we follow Cover Art Archive's 307 redirect to the actual image
     • we accept image/jpeg, image/png, or image/* without sniffing —
       CAA's "front" endpoint negotiates a JPEG by default and we save
       under .jpg regardless of what came back. */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_BYTES = 20 * 1024 * 1024;     // album art can be 1500x1500 PNG = ~3 MB; 20 is generous
const MAX_REDIRECTS = 5;

function pickClient(url) {
  return url.startsWith('https:') ? https : http;
}

function download(url, targetPath, redirectsRemaining = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const client = pickClient(url);
    const req = client.get(url, {
      timeout: DOWNLOAD_TIMEOUT_MS,
      headers: { 'User-Agent': 'TrailCurrent-Playbill/0.1' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsRemaining <= 0) { reject(new Error('too many redirects')); return; }
        const next = new URL(res.headers.location, url).toString();
        download(next, targetPath, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const tmp = targetPath + '.part';
      let bytes = 0;
      const out = fs.createWriteStream(tmp, { mode: 0o644 });
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy(new Error('response exceeded MAX_BYTES'));
          out.destroy();
          try { fs.unlinkSync(tmp); } catch (_) {}
        }
      });
      res.on('error', (e) => { out.destroy(); try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
      out.on('error', (e) => { reject(e); });
      out.on('close', () => {
        try { fs.renameSync(tmp, targetPath); resolve({ path: targetPath, bytes }); }
        catch (e) { reject(e); }
      });
      res.pipe(out);
    });
    req.on('timeout', () => { req.destroy(new Error('download timed out')); });
    req.on('error', reject);
  });
}

/**
 * Download a Cover Art Archive (or arbitrary) image URL to
 * <dir>/cover.jpg and patch the album's sidecar to point at it.
 *
 * @param {object} opts
 * @param {string} opts.url        Source URL (CAA front-image or other)
 * @param {string} opts.dir        Album folder
 * @param {string} opts.sidecar    Path to the album JSON sidecar
 */
async function downloadCoverArt({ url, dir, sidecar }) {
  if (!url) return { ok: false, error: 'no cover-art url' };
  if (!dir) return { ok: false, error: 'dir required' };
  const target = path.join(dir, 'cover.jpg');
  try {
    const { bytes } = await download(url, target);
    if (sidecar) {
      try {
        const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
        meta.coverPath = 'cover.jpg';
        meta.coverBytes = bytes;
        fs.writeFileSync(sidecar, JSON.stringify(meta, null, 2));
      } catch (e) {
        console.warn('[cd-artwork] sidecar update failed:', e.message);
      }
    }
    return { ok: true, coverPath: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { downloadCoverArt };
