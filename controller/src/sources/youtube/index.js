/* YouTube source plugin (Phase 6a — anonymous browse + resolve).

   Implements the source-plugin contract from architecture-v2 §5. The
   generic handlers/source.js dispatcher invokes these methods by name
   based on the {action, sourceId} envelope from the bus.

   Phase 6a scope: anonymous (no sign-in). Search and direct video play
   work without OAuth. Browse hierarchy is intentionally minimal — just a
   "/search/<query>" route. Subscriptions, history, watch later land in
   Phase 6c when device-flow OAuth comes online.

   Path conventions (UI navigates by passing path into list()):
     /                        landing — recommends searching
     /search/<query>          search results
     /watch/<videoId>         single video (not really a "list" — used as
                              a deep link target by source.launch) */

'use strict';

const ytdlp   = require('./yt-dlp');
const auth    = require('./auth');
const dataApi = require('./data-api');

const id          = 'youtube';
const displayName = 'YouTube';
const icon        = 'logo-youtube';
const capabilities = ['browse', 'search', 'signin'];

async function list(rawPath) {
  const p = String(rawPath || '/').replace(/\/+$/, '') || '/';

  if (p === '/') {
    const items = [
      {
        id: 'search', type: 'directory', sourceId: id,
        title: 'Search YouTube', subtitle: 'Find videos by keyword',
        targetPath: '/search/',
      },
    ];
    if (auth.isSignedIn()) {
      items.unshift({
        id: 'subscriptions', type: 'directory', sourceId: id,
        title: 'My Subscriptions', subtitle: 'Channels you follow',
        targetPath: '/subscriptions',
      });
    }
    return { path: '/', items };
  }

  if (p.startsWith('/search/')) {
    const query = decodeURIComponent(p.slice('/search/'.length));
    if (!query) return { path: p, items: [] };
    const items = await ytdlp.search(query, 25);
    return { path: p, items };
  }

  if (p === '/subscriptions') {
    if (!auth.isSignedIn()) throw new Error('Sign in to YouTube to see your subscriptions');
    const r = await dataApi.listSubscriptions();
    return { path: p, items: r.items };
  }

  // /channel/<id>/uploads — recent uploads from a channel
  const channelMatch = p.match(/^\/channel\/([^\/]+)\/uploads$/);
  if (channelMatch) {
    if (!auth.isSignedIn()) throw new Error('Sign in to YouTube to browse channels');
    const r = await dataApi.listChannelUploads(channelMatch[1]);
    return { path: p, items: r.items };
  }

  throw new Error(`youtube.list: unknown path "${p}"`);
}

async function search(query, limit) {
  return { items: await ytdlp.search(query, limit) };
}

async function resolve(item) {
  // `item` is what list/search returned (or what a CAN-side caller hands
  // us). Accept a string videoId, a {id} object, or a full search result.
  const videoId = (typeof item === 'string') ? item
                : (item && (item.id || item.videoId || item.url));
  if (!videoId) throw new Error('youtube.resolve: item.id required');

  const playable = await ytdlp.resolve(videoId);

  // Best-effort metadata. We avoid a second yt-dlp call here for latency —
  // the caller usually has a search result already; a follow-up
  // source.getMetadata can fetch the full --dump-json if needed.
  const metadata = (typeof item === 'object' && item) ? {
    sourceItemId: videoId,
    title:        item.title || null,
    subtitle:     item.channel || null,
    artworkUrl:   item.thumbnail || null,
    durationMs:   item.duration ? item.duration * 1000 : null,
  } : { sourceItemId: videoId };

  return { ...playable, metadata };
}

async function probeTools() { return ytdlp.probeTools(); }

module.exports = {
  id, displayName, icon, capabilities,
  list, search, resolve, probeTools,
};
