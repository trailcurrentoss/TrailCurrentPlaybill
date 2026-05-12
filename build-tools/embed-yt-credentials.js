#!/usr/bin/env node
/* Bake the YouTube OAuth credentials from .env into a generated JS module
   the controller can require at runtime. The .env file lives at the repo
   root and is gitignored; the generated default-client.local.js sits next
   to default-client.js inside the controller and is ALSO gitignored. The
   running app does not read .env — by build time the values are committed
   to the asar.

   Inputs:  <repo>/.env
   Outputs: <repo>/controller/src/sources/youtube/default-client.local.js

   If .env is missing, this writes an empty default-client.local.js so the
   controller still loads — the user just won't have a built-in OAuth
   client (Sign In will error with an actionable message). */

'use strict';

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH  = path.join(REPO_ROOT, '.env');
const OUT_PATH  = path.join(REPO_ROOT, 'controller', 'src', 'sources', 'youtube', 'default-client.local.js');

function parseEnv(content) {
  const out = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function jsString(s) { return JSON.stringify(String(s)); }

(function main() {
  let clientId = '', clientSecret = '';
  if (fs.existsSync(ENV_PATH)) {
    const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
    clientId     = env.PLAYBILL_YT_CLIENT_ID     || '';
    clientSecret = env.PLAYBILL_YT_CLIENT_SECRET || '';
  }

  const banner = '/* GENERATED — do not edit. Source: <repo>/.env (gitignored).\n' +
                 '   Regenerate with `node build-tools/embed-yt-credentials.js`. */\n';
  const body = clientId && clientSecret
    ? `module.exports = { clientId: ${jsString(clientId)}, clientSecret: ${jsString(clientSecret)} };\n`
    : 'module.exports = null;\n';

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, banner + body, { mode: 0o600 });

  if (clientId && clientSecret) {
    console.log(`[embed-yt-credentials] wrote ${path.relative(REPO_ROOT, OUT_PATH)} (clientId ${clientId.slice(0, 12)}…)`);
  } else {
    console.warn(`[embed-yt-credentials] .env missing or incomplete — wrote empty default-client.local.js`);
  }
})();
