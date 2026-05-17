/* Audio-CD ripper — wraps cdparanoia + flac to extract every track off
   an audio CD into per-track FLAC files. Emits 'progress' events as
   each track completes so the GUI can show "Ripping 7 of 12" + a per-
   track percentage.

   Why cdparanoia + flac (instead of abcde, EAC, or a one-shot tool):
     • cdparanoia is the only ripper on Linux that re-reads cycle-slipping
       sectors until a stable read is obtained. Off-grid use means we
       only get one shot at a disc — accuracy beats speed.
     • flac is the only codec on Linux that's both lossless AND has
       playback support in mpv out of the box. Off-grid use also means
       no streaming services, so storing music losslessly preserves the
       option to re-encode later for a phone / car / etc.
     • abcde wraps both but is interactive by default and pulls metadata
       from CDDB instead of MusicBrainz — wrong direction for us.
     • EAC is Windows-only.

   The rip flow per track:
     1. cdparanoia writes WAV to a temp file in the album dir.
     2. flac transcodes WAV → FLAC, then deletes the WAV.
     3. We patch the album sidecar with the track's local file path.

   Output layout:
     ~/Playbill/Music/<Artist>/<Album> (<Year>)/
       01 - <Track 1 Title>.flac
       02 - <Track 2 Title>.flac
       ...
       cover.jpg
       album.json

   The sidecar lives at album.json — one file per album, listing every
   track in order with their metadata. The library scanner reads sidecars
   to render the album grid + drill-in tracklist. */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { downloadCoverArt } = require('./cd-artwork');

const LIBRARY_ROOT = path.join(os.homedir(), 'Playbill', 'Music');
const CDPARANOIA_BIN = 'cdparanoia';
const FLAC_BIN = 'flac';

function safeName(s) {
  return String(s || 'Unknown')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function albumPathFor(metadata) {
  const artist = safeName(metadata.artist || 'Unknown Artist');
  const album  = safeName(metadata.title  || 'Unknown Album');
  const titleYear = metadata.year ? `${album} (${metadata.year})` : album;
  const dir = path.join(LIBRARY_ROOT, artist, titleYear);
  return {
    dir,
    sidecar: path.join(dir, 'album.json'),
    cover:   path.join(dir, 'cover.jpg'),
  };
}

function trackFilename(track) {
  const num = String(track.number || 0).padStart(2, '0');
  return `${num} - ${safeName(track.title || `Track ${track.number || 0}`)}`;
}

function probeBinary(bin) {
  return new Promise((resolve) => {
    execFile('which', [bin], (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}
function probeCdparanoia() { return probeBinary(CDPARANOIA_BIN); }
function probeFlac()        { return probeBinary(FLAC_BIN); }

class CdRipper extends EventEmitter {
  constructor() {
    super();
    this._proc = null;
    this._currentTarget = null;
    this._currentMetadata = null;
    this._lastProgress = null;
    this._cancelled = false;
  }

  isRipping() { return !!this._proc || this._cancelled; }
  getProgress() { return this._lastProgress; }
  getCurrent() { return this._currentMetadata; }

  /**
   * Begin a rip. Throws if a rip is already in progress.
   *
   * @param {object} opts
   * @param {string} opts.device   /dev/sr0
   * @param {object} opts.metadata Album-level metadata. Required: title,
   *                               artist, tracks[]. Optional: year, mbid,
   *                               coverArtUrl, country, barcode.
   */
  async start({ device, metadata }) {
    if (this._proc) throw new Error('rip already in progress');
    if (!metadata || !metadata.title) throw new Error('metadata.title required');
    if (!Array.isArray(metadata.tracks) || metadata.tracks.length === 0) {
      throw new Error('metadata.tracks required');
    }

    this._cancelled = false;
    const target = albumPathFor(metadata);
    fs.mkdirSync(target.dir, { recursive: true });

    // Write the sidecar up front so a partial rip is recoverable. The
    // library scanner only surfaces albums whose sidecar lists at least
    // one track whose .flac exists, so a half-finished rip won't show
    // up broken — but the sidecar means we know what we WERE ripping.
    const sidecar = {
      ...metadata,
      rippedFromDevice: device,
      rippedAt: new Date().toISOString(),
      tracks: metadata.tracks.map((t) => ({
        ...t,
        // file is the relative path inside the album dir; gets set as
        // each track completes successfully.
        file: null,
      })),
    };
    fs.writeFileSync(target.sidecar, JSON.stringify(sidecar, null, 2));

    // Kick off cover-art download in parallel — same pattern as the DVD
    // poster path. Doesn't block ripping; lands when it lands.
    if (metadata.coverArtUrl) {
      downloadCoverArt({ url: metadata.coverArtUrl, dir: target.dir, sidecar: target.sidecar })
        .then((r) => {
          if (r.ok) this.emit('cover-saved', { path: r.coverPath, metadata });
          else      console.warn(`[cd-ripper] cover download failed for "${metadata.title}":`, r.error);
        });
    }

    this._currentTarget = target;
    this._currentMetadata = metadata;
    this._lastProgress = { trackIndex: 0, ntracks: metadata.tracks.length, percent: 0, currentTitle: metadata.title };

    // Rip tracks sequentially. cdparanoia owns the drive exclusively;
    // parallel rips would just thrash the head.
    try {
      for (let i = 0; i < metadata.tracks.length; i++) {
        if (this._cancelled) break;
        const track = metadata.tracks[i];
        const base = trackFilename(track);
        const wavPath  = path.join(target.dir, base + '.wav');
        const flacPath = path.join(target.dir, base + '.flac');

        this._lastProgress = {
          trackIndex: i + 1,
          ntracks: metadata.tracks.length,
          percent: (i / metadata.tracks.length) * 100,
          currentTitle: track.title || `Track ${i + 1}`,
        };
        this.emit('progress', this._lastProgress);

        await this._ripTrack({ device, trackNumber: track.number || (i + 1), wavPath });
        if (this._cancelled) {
          try { fs.unlinkSync(wavPath); } catch (_) {}
          break;
        }
        await this._encodeFlac({ wavPath, flacPath, track, album: metadata });
        try { fs.unlinkSync(wavPath); } catch (_) {}

        // Patch the sidecar with this track's relative file path so the
        // library scanner picks up partial rips correctly.
        try {
          const cur = JSON.parse(fs.readFileSync(target.sidecar, 'utf8'));
          if (cur.tracks && cur.tracks[i]) {
            cur.tracks[i].file = path.basename(flacPath);
            fs.writeFileSync(target.sidecar, JSON.stringify(cur, null, 2));
          }
        } catch (_) { /* best-effort */ }
      }

      // Final 100% emit + finished event.
      if (this._cancelled) {
        this._lastProgress = null;
        this._proc = null;
        this._currentTarget = null;
        this._currentMetadata = null;
        this.emit('cancelled', { metadata });
        return { cancelled: true };
      }
      this._lastProgress = {
        trackIndex: metadata.tracks.length,
        ntracks: metadata.tracks.length,
        percent: 100,
        currentTitle: metadata.title,
      };
      this.emit('progress', this._lastProgress);
      this.emit('finished', { path: target.dir, metadata, sidecar: target.sidecar });
      const result = { path: target.dir, sidecar: target.sidecar };
      this._lastProgress = null;
      this._currentTarget = null;
      this._currentMetadata = null;
      return result;
    } catch (e) {
      this._lastProgress = null;
      this._proc = null;
      this._currentTarget = null;
      this._currentMetadata = null;
      this.emit('failed', { metadata, error: e.message });
      throw e;
    }
  }

  _ripTrack({ device, trackNumber, wavPath }) {
    return new Promise((resolve, reject) => {
      // cdparanoia args:
      //   -d <device>     source drive
      //   -w              write WAV header
      //   <track>         track number (1-indexed)
      //   <out>           output WAV path
      const args = ['-d', device, '-w', String(trackNumber), wavPath];
      const child = spawn(CDPARANOIA_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this._proc = child;

      let stderrTail = '';
      child.stdout.on('data', () => { /* cdparanoia writes progress to stderr */ });
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
        // cdparanoia emits per-sector progress; we deliberately don't
        // parse it (would swamp the IPC channel). Per-track granularity
        // is enough for the GUI.
      });
      child.on('error', (e) => {
        this._proc = null;
        reject(new Error(`cdparanoia spawn failed: ${e.message}`));
      });
      child.on('exit', (code, signal) => {
        this._proc = null;
        if (this._cancelled || signal === 'SIGTERM' || signal === 'SIGINT') {
          resolve({ cancelled: true });
          return;
        }
        if (code === 0) {
          resolve({ wavPath });
        } else {
          reject(new Error(`cdparanoia exited ${code}: ${stderrTail.split('\n').slice(-2).join(' | ')}`));
        }
      });
    });
  }

  _encodeFlac({ wavPath, flacPath, track, album }) {
    return new Promise((resolve, reject) => {
      // flac args:
      //   --best                     highest compression
      //   -o <out>                   output path
      //   --tag=...                  Vorbis comments
      const tags = [
        `--tag=TITLE=${track.title || ''}`,
        `--tag=ARTIST=${track.artist || album.artist || ''}`,
        `--tag=ALBUM=${album.title || ''}`,
        `--tag=ALBUMARTIST=${album.artist || ''}`,
        `--tag=TRACKNUMBER=${track.number || ''}`,
        `--tag=TRACKTOTAL=${album.tracks.length}`,
        album.year ? `--tag=DATE=${album.year}` : null,
        album.mbid ? `--tag=MUSICBRAINZ_ALBUMID=${album.mbid}` : null,
      ].filter(Boolean);
      const args = ['--best', '-f', '-s', '-o', flacPath, ...tags, wavPath];
      const child = spawn(FLAC_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this._proc = child;
      let stderrTail = '';
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2048);
      });
      child.on('error', (e) => {
        this._proc = null;
        reject(new Error(`flac spawn failed: ${e.message}`));
      });
      child.on('exit', (code, signal) => {
        this._proc = null;
        if (this._cancelled || signal === 'SIGTERM') { resolve({ cancelled: true }); return; }
        if (code === 0) resolve({ flacPath });
        else            reject(new Error(`flac exited ${code}: ${stderrTail.split('\n').slice(-2).join(' | ')}`));
      });
    });
  }

  cancel() {
    if (!this._proc && !this._cancelled) return false;
    this._cancelled = true;
    if (this._proc) { try { this._proc.kill('SIGTERM'); } catch (_) {} }
    return true;
  }
}

const singleton = new CdRipper();
module.exports = singleton;
module.exports.LIBRARY_ROOT = LIBRARY_ROOT;
module.exports.albumPathFor = albumPathFor;
module.exports.probeCdparanoia = probeCdparanoia;
module.exports.probeFlac = probeFlac;
module.exports.safeName = safeName;
