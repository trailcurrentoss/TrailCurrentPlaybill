/* Poster downloader — pulls a poster URL (typically OMDb's Amazon CDN
   link) down to a local .jpg next to the ripped .mkv so the library
   keeps rendering posters when the rig is off-grid.

   Best-effort by design: TrailCurrent's primary use is no-internet, so
   the rip flow must NEVER fail because the poster couldn't be fetched.
   The caller fires this and ignores rejection; failures are logged at
   warn level only. */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_BYTES = 10 * 1024 * 1024;     // 10 MB — a movie poster is <200 KB; this is the
                                        // upper bound that protects against a misconfigured
                                        // server streaming an unbounded body to us.
const MAX_REDIRECTS = 5;

function pickClient(url) {
  return url.startsWith('https:') ? https : http;
}

/**
 * Download a URL to a target file. Follows up to MAX_REDIRECTS hops.
 * Rejects on timeout, HTTP >= 400, or size > MAX_BYTES. Resolves with
 * { path, bytes } on success.
 */
function download(url, targetPath, redirectsRemaining = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const client = pickClient(url);
    const req = client.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      // Follow 30x.
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
        // Atomic-ish rename so a partial download never appears as a
        // "real" poster on disk — the library scanner reads the file by
        // its final name. Failed downloads leave .part files which the
        // scanner ignores.
        try {
          fs.renameSync(tmp, targetPath);
          resolve({ path: targetPath, bytes });
        } catch (e) { reject(e); }
      });
      res.pipe(out);
    });
    req.on('timeout', () => { req.destroy(new Error('download timed out')); });
    req.on('error', reject);
  });
}

/**
 * Download a poster URL to <dir>/<basename>.jpg. Updates the JSON
 * sidecar at <dir>/<basename>.json so the library scanner picks up
 * the local path. Best-effort — never throws to the caller.
 *
 * @param {object} opts
 * @param {string} opts.url       Poster URL (e.g. OMDb's Amazon link)
 * @param {string} opts.dir       Folder containing the .mkv + .json
 * @param {string} opts.basename  '<Title (Year)>' (no extension)
 * @returns {Promise<{ok: boolean, posterPath?: string, error?: string}>}
 */
async function downloadPoster({ url, dir, basename }) {
  if (!url) return { ok: false, error: 'no poster url' };
  if (!dir || !basename) return { ok: false, error: 'dir + basename required' };
  // OMDb posters are JPG so we hardcode the extension. If we ever
  // support providers that serve PNG we'd sniff Content-Type here.
  const target = path.join(dir, basename + '.jpg');
  const jsonPath = path.join(dir, basename + '.json');
  try {
    const { bytes } = await download(url, target);
    // Patch the sidecar with the relative filename. Relative (not
    // absolute) so the library is portable — copy the folder to a NAS
    // or a backup and the sidecar still points at the right file.
    try {
      const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      meta.posterPath = path.basename(target);
      meta.posterBytes = bytes;
      fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2));
    } catch (e) {
      // Sidecar missing or unreadable — poster is downloaded but the
      // library scanner won't find it. Still better than nothing; log
      // and return ok:true so the caller doesn't retry.
      console.warn('[dvd-poster] sidecar update failed:', e.message);
    }
    return { ok: true, posterPath: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { downloadPoster };
