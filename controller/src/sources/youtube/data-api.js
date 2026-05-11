/* YouTube Data API v3 — minimal client.

   Personalized browse uses Google's official REST API (subscriptions,
   playlists, watch later, channel info). Stream URL extraction stays on
   yt-dlp because the Data API doesn't expose decoded media URLs.

   All requests authenticated via the OAuth access_token from
   sources/youtube/auth.js. We pass the token via Authorization: Bearer —
   no API key needed when the user is signed in.

   Responses are normalized into the same shape the source plugin's list()
   already returns elsewhere (id, type, sourceId, title, channel, ...).

   This file is intentionally tiny — add methods as the UI needs them.
   Subscriptions + playlist items + my-channel are enough for Phase 6c.2. */

'use strict';

const auth = require('./auth');

const API_BASE = 'https://www.googleapis.com/youtube/v3';

async function _get(path, params = {}) {
  const token = await auth.getAccessToken();
  if (!token) throw new Error('YouTube Data API: not signed in');

  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  if (!r.ok) {
    const msg = j.error && j.error.message ? j.error.message : ('http_' + r.status);
    throw new Error(`Data API ${path} ${r.status}: ${msg}`);
  }
  return j;
}

/** "Signed in as" label — channel title + thumbnail of the user. */
async function getMyChannel() {
  const j = await _get('/channels', { part: 'snippet,contentDetails', mine: 'true' });
  if (!j.items || !j.items.length) return null;
  const ch = j.items[0];
  return {
    channelId:  ch.id,
    title:      ch.snippet && ch.snippet.title,
    thumbnail:  ch.snippet && ch.snippet.thumbnails && ch.snippet.thumbnails.default && ch.snippet.thumbnails.default.url,
    // Convenient playlist IDs for "watch later" and "history" — these only
    // come back here, not in any other endpoint.
    likes:      ch.contentDetails && ch.contentDetails.relatedPlaylists && ch.contentDetails.relatedPlaylists.likes,
    uploads:    ch.contentDetails && ch.contentDetails.relatedPlaylists && ch.contentDetails.relatedPlaylists.uploads,
  };
}

/** List the signed-in user's subscriptions. */
async function listSubscriptions(pageToken) {
  const params = { part: 'snippet', mine: 'true', maxResults: '50', order: 'alphabetical' };
  if (pageToken) params.pageToken = pageToken;
  const j = await _get('/subscriptions', params);
  return {
    items: (j.items || []).map((s) => ({
      id:        s.snippet.resourceId && s.snippet.resourceId.channelId,
      type:      'directory',
      sourceId:  'youtube',
      title:     s.snippet.title,
      subtitle:  null,
      thumbnail: s.snippet.thumbnails && (s.snippet.thumbnails.medium || s.snippet.thumbnails.default || {}).url,
      targetPath: '/channel/' + (s.snippet.resourceId && s.snippet.resourceId.channelId) + '/uploads',
    })),
    nextPageToken: j.nextPageToken || null,
  };
}

/** Recent videos from a specific channel, via its uploads playlist. */
async function listChannelUploads(channelId, pageToken) {
  // First resolve the channel's uploads playlist ID.
  const chRes = await _get('/channels', { part: 'contentDetails', id: channelId });
  const upPlaylistId = chRes.items && chRes.items[0] &&
    chRes.items[0].contentDetails &&
    chRes.items[0].contentDetails.relatedPlaylists &&
    chRes.items[0].contentDetails.relatedPlaylists.uploads;
  if (!upPlaylistId) throw new Error(`channel ${channelId}: no uploads playlist`);
  return listPlaylistItems(upPlaylistId, pageToken);
}

/** Items in a playlist (used for uploads, watch later, custom playlists). */
async function listPlaylistItems(playlistId, pageToken) {
  const params = { part: 'snippet,contentDetails', playlistId, maxResults: '50' };
  if (pageToken) params.pageToken = pageToken;
  const j = await _get('/playlistItems', params);
  return {
    items: (j.items || []).map((it) => ({
      id:        it.contentDetails && it.contentDetails.videoId,
      type:      'video',
      sourceId:  'youtube',
      title:     it.snippet && it.snippet.title,
      channel:   it.snippet && it.snippet.videoOwnerChannelTitle,
      thumbnail: it.snippet && it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default || {}).url,
      url:       it.contentDetails && it.contentDetails.videoId ? `https://www.youtube.com/watch?v=${it.contentDetails.videoId}` : null,
    })).filter((it) => !!it.id),
    nextPageToken: j.nextPageToken || null,
  };
}

module.exports = { getMyChannel, listSubscriptions, listChannelUploads, listPlaylistItems };
