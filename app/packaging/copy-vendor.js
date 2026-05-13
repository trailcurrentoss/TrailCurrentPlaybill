/* Copy vendored runtime libraries from node_modules into renderer/vendor/.
   Runs as part of `npm run build`. Lets the renderer load React and Ionicons
   over file:// without internet, and keeps the renderer free of any bundler. */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'renderer', 'vendor');

// npm workspaces hoist transitive dependencies to the workspace root, so
// `node_modules/react` may live one or more directories above this app.
// `require.resolve('<pkg>/package.json')` returns the actual on-disk location
// regardless of hoisting; the package directory is its parent.
function pkgDir(name) {
  return path.dirname(require.resolve(`${name}/package.json`, { paths: [ROOT] }));
}

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`  ${path.relative(ROOT, dst)}`);
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

console.log('Vendoring runtime libraries into renderer/vendor/ …');

fs.rmSync(VENDOR, { recursive: true, force: true });
fs.mkdirSync(VENDOR, { recursive: true });

// React — UMD development build (small enough; gives us readable stacks if anything blows up).
// In Stage 2 we'll switch to .production.min.js builds.
copy(path.join(pkgDir('react'),     'umd/react.development.js'),     path.join(VENDOR, 'react.js'));
copy(path.join(pkgDir('react-dom'), 'umd/react-dom.development.js'), path.join(VENDOR, 'react-dom.js'));

// Ionicons — Stencil-based web component package. Ship the whole dist tree
// so the lazy-loader can find every icon SVG offline.
copyTree(path.join(pkgDir('ionicons'), 'dist'), path.join(VENDOR, 'ionicons'));

// MapLibre GL JS — vector-tile map renderer used by the Explore screen.
// Use the *-csp builds: the regular maplibre-gl.js inlines a Web Worker via
// `new Worker(URL.createObjectURL(new Blob(...)))` which violates Electron's
// `script-src 'self'`. The -csp build separates the worker into its own
// file so we can load it from /vendor/ over file:// with no inline scripts.
// `setWorkerUrl` in explore.jsx points the runtime at the vendored worker.
const MAPLIBRE_DIR = path.join(VENDOR, 'maplibre');
fs.mkdirSync(MAPLIBRE_DIR, { recursive: true });
copy(path.join(pkgDir('maplibre-gl'), 'dist/maplibre-gl-csp.js'),        path.join(MAPLIBRE_DIR, 'maplibre-gl-csp.js'));
copy(path.join(pkgDir('maplibre-gl'), 'dist/maplibre-gl-csp-worker.js'), path.join(MAPLIBRE_DIR, 'maplibre-gl-csp-worker.js'));
copy(path.join(pkgDir('maplibre-gl'), 'dist/maplibre-gl.css'),           path.join(MAPLIBRE_DIR, 'maplibre-gl.css'));

console.log('Done.');
