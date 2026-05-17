/* YouTube source plugin.

   Implements the source-plugin contract from architecture-v2 §5. The
   generic handlers/source.js dispatcher invokes these methods by name
   based on the {action, sourceId} envelope from the bus.

   Two parallel paths:
     • Anonymous: search + playback. No sign-in needed; yt-dlp scrapes the
       public web frontend. Works on every device with no setup.
     • Signed-in (optional): four personalized lists exposed via the
       YouTube Data API — Subscriptions, Your Videos (uploads), Liked
       Videos, Created Playlists. We intentionally do NOT surface
       Recommended / Watch History / Watch Later because Google removed
       Data-API read access for those (HL/WL playlists return empty;
       there's no personalized-home endpoint at all). Adding them would
       require a parallel yt-dlp-with-cookies path that the user explicitly
       opted out of.

   Path conventions (UI navigates by passing path into list()):
     /                              landing — search + signed-in tiles
     /search/<query>                search results (yt-dlp, no sign-in)
     /subscriptions                 channels the user follows
     /uploads                       the signed-in user's own uploads
     /likes                         videos the user has liked
     /playlists                     playlists the user has created
     /playlist/<id>                 videos in a specific playlist
     /channel/<channelId>/uploads   recent uploads from a specific channel
     /watch/<videoId>               single video (used as deep-link target
                                    by source.launch) */

'use strict';

const ytdlp   = require('./yt-dlp');
const auth    = require('./auth');
const dataApi = require('./data-api');

const id          = 'youtube';
const displayName = 'YouTube';
const icon        = 'logo-youtube';
const capabilities = ['browse', 'search', 'signin'];

async function _myChannel() {
  const r = await dataApi.getMyChannel();
  if (!r) throw new Error('Could not load your YouTube channel — try signing out and back in.');
  return r;
}

async function list(rawPath) {
  const p = String(rawPath || '/').replace(/\/+$/, '') || '/';

  if (p === '/') {
    // Landing page tiles. Only the four personalized lists; search has
    // its own always-visible input at the top of the YouTube screen so
    // a tile for it would just duplicate the same entry point. When the
    // user is signed out we return an empty list — the renderer falls
    // through to the search-only layout. Search is identical signed-in
    // or signed-out (always yt-dlp scraping; the Data API's search
    // endpoint costs 100 quota units per call and we never use it).
    const items = [];
    if (auth.isSignedIn()) {
      items.push(
        { id: 'subscriptions', type: 'directory', sourceId: id,
          title: 'Subscriptions', subtitle: 'Channels you follow',
          targetPath: '/subscriptions' },
        { id: 'uploads', type: 'directory', sourceId: id,
          title: 'Your Videos', subtitle: 'Videos you uploaded',
          targetPath: '/uploads' },
        { id: 'likes', type: 'directory', sourceId: id,
          title: 'Liked Videos', subtitle: 'Videos you liked',
          targetPath: '/likes' },
        { id: 'playlists', type: 'directory', sourceId: id,
          title: 'Playlists', subtitle: 'Playlists you created',
          targetPath: '/playlists' },
      );
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

  if (p === '/uploads') {
    if (!auth.isSignedIn()) throw new Error('Sign in to YouTube to see your uploads');
    const me = await _myChannel();
    if (!me.uploads) return { path: p, items: [] };
    const r = await dataApi.listPlaylistItems(me.uploads);
    return { path: p, items: r.items };
  }

  if (p === '/likes') {
    if (!auth.isSignedIn()) throw new Error('Sign in to YouTube to see your liked videos');
    const me = await _myChannel();
    if (!me.likes) return { path: p, items: [] };
    const r = await dataApi.listPlaylistItems(me.likes);
    return { path: p, items: r.items };
  }

  if (p === '/playlists') {
    if (!auth.isSignedIn()) throw new Error('Sign in to YouTube to see your playlists');
    const r = await dataApi.listMyPlaylists();
    return { path: p, items: r.items };
  }

  // /playlist/<id> — items inside any playlist (user-created or otherwise).
  const playlistMatch = p.match(/^\/playlist\/([^\/]+)$/);
  if (playlistMatch) {
    if (!auth.isSignedIn()) throw new Error('Sign in to YouTube to browse playlists');
    const r = await dataApi.listPlaylistItems(playlistMatch[1]);
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
