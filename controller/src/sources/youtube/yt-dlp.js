/* yt-dlp wrapper. Phase 6a — anonymous browse + resolve.

   yt-dlp is the long-lived fork of youtube-dl. It tracks YouTube's
   ever-changing player JS / signature ciphers / n-param throttling and
   exposes search + URL extraction as a CLI. Wrapping the CLI (vs. shipping
   a JS port) is deliberate: we get the maintenance treadmill for free
   from the upstream package.

   We never ask yt-dlp to download — only to list metadata (--dump-json)
   and resolve playable URLs (--get-url with -g and -j). mpv plays the
   resolved URLs directly with hardware decode.

   Public surface:
     search(query, limit)  → [{ id, title, channel, duration, thumbnail, ... }]
     resolve(videoId)      → { url, headers, mediaType }
     videoInfo(videoId)    → full --dump-json metadata

   Sign-in (Phase 6c) layers on top via yt-dlp's --cookies / --username
   / --client / --extractor-args. None of that here yet. */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const YTDLP = 'yt-dlp';

// Default format: best video <=1080p plus best audio, falling back to a
// single combined stream if mux isn't available. mpv handles both.
const DEFAULT_FORMAT = 'bestvideo[height<=?1080]+bestaudio/best[height<=?1080]/best';

// Generous buffer — yt-dlp can take a few seconds for first-time invocations
// (extractor warmup, signature-cache miss).
const EXEC_OPTS = { maxBuffer: 32 * 1024 * 1024, timeout: 30000 };

/**
 * Search YouTube for `query`, return up to `limit` results.
 * Uses yt-dlp's `ytsearchN:` URL form which doesn't require an API key.
 */
async function search(query, limit = 25) {
  if (!query || typeof query !== 'string') throw new Error('search: query required');
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 25));
  const args = [
    `ytsearch${safeLimit}:${query}`,
    '--dump-json',
    '--flat-playlist',     // don't fetch each video's full metadata, just listing
    '--no-warnings',
    '--no-check-certificate',  // some boards have stale CAs; relax for search probe only
  ];
  const { stdout } = await execFileP(YTDLP, args, EXEC_OPTS);
  return parseJsonLines(stdout).map(toItemSummary);
}

/**
 * Resolve a video to a playable URL. Returns { url, headers, mediaType }.
 * `url` is the merged-format playlist (or a single direct URL); mpv handles
 * the rest.
 */
async function resolve(videoId, { format = DEFAULT_FORMAT } = {}) {
  if (!videoId) throw new Error('resolve: videoId required');
  const target = videoId.includes('://') ? videoId : `https://www.youtube.com/watch?v=${videoId}`;
  const args = [
    target,
    '-f', format,
    '-g',                    // print URL only, don't download
    '--no-warnings',
    '--no-check-certificate',
  ];
  const { stdout } = await execFileP(YTDLP, args, EXEC_OPTS);
  // -g with merged formats prints multiple URLs (video + audio). mpv can
  // take the first one and handle audio via merge-script, but for our
  // simpler case we'll prefer a single combined stream. Fall back gracefully.
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('resolve: yt-dlp returned no URL');
  // Take the first URL — for merged video+audio yt-dlp returns video first;
  // mpv with --audio-file= would need the second. For a v1 cut, accept
  // single-stream playback; quality loss vs. merged is real but acceptable.
  // Phase 6b will switch to passing both URLs to mpv via --audio-file.
  return {
    url: lines[0],
    audioUrl: lines[1] || null,
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) yt-dlp' },
    mediaType: 'video',
  };
}

/** Full --dump-json metadata for a single video. Used for richer resolve responses. */
async function videoInfo(videoId) {
  const target = videoId.includes('://') ? videoId : `https://www.youtube.com/watch?v=${videoId}`;
  const args = [target, '--dump-json', '--no-warnings', '--no-check-certificate'];
  const { stdout } = await execFileP(YTDLP, args, EXEC_OPTS);
  const arr = parseJsonLines(stdout);
  if (arr.length === 0) throw new Error('videoInfo: yt-dlp returned no JSON');
  return toItemFull(arr[0]);
}

async function probeTools() {
  try {
    const { stdout } = await execFileP(YTDLP, ['--version'], { timeout: 4000 });
    return { ytdlp: true, version: stdout.trim() };
  } catch (e) {
    return { ytdlp: false, error: e.message };
  }
}

// ── JSON helpers ──────────────────────────────────────────────────────

function parseJsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* ignore garbage */ }
  }
  return out;
}

function toItemSummary(j) {
  return {
    id:        j.id || j.url,
    type:      'video',
    sourceId:  'youtube',
    title:     j.title || '(untitled)',
    channel:   j.uploader || j.channel || null,
    duration:  j.duration || null,
    thumbnail: j.thumbnail || (j.thumbnails && j.thumbnails[0] && j.thumbnails[0].url) || null,
    viewCount: j.view_count || null,
    url:       j.webpage_url || (j.id ? `https://www.youtube.com/watch?v=${j.id}` : null),
  };
}

function toItemFull(j) {
  return {
    ...toItemSummary(j),
    description: j.description || null,
    uploadDate:  j.upload_date || null,
    tags:        j.tags || [],
    formats:     (j.formats || []).map(f => ({ format_id: f.format_id, ext: f.ext, height: f.height, filesize: f.filesize })),
  };
}

module.exports = { search, resolve, videoInfo, probeTools };
