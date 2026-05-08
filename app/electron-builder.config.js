module.exports = {
  appId: 'com.trailcurrent.playbill',
  productName: 'TrailCurrent Playbill',
  copyright: 'Copyright © TrailCurrent',

  directories: {
    output: 'dist',
    buildResources: 'packaging'
  },

  files: [
    'main/**/*',
    'renderer/**/*',
    'build/**/*',
    'package.json',
    '!**/*.map',
    '!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme}',
    '!**/node_modules/.bin',
    '!**/node_modules/7zip-bin/**',
    '!**/node_modules/app-builder-bin/**'
  ],

  // We do NOT produce a .deb. The Q6A image build stages the unpacked
  // Electron app directly into /opt/trailcurrent-playbill/ and drops the
  // .desktop entry + icons into the rootfs as separate files via the
  // install-electron-runtime hook.
  linux: {
    target: [{ target: 'dir', arch: ['arm64'] }],
    category: 'AudioVideo',
    description: 'TrailCurrent Playbill — turn the desktop into the rig entertainment center.',
    icon: 'packaging/icons',
    maintainer: 'TrailCurrent <support@trailcurrent.com>',
    vendor: 'TrailCurrent'
  },

  asar: true,
  compression: 'normal',

  // Don't have electron-builder reinstall production deps inside a temp dir —
  // npm workspaces hoist deps to the workspace root and the reinstall wipes
  // 7zip-bin / app-builder-bin which electron-builder itself depends on.
  // npmRebuild stays true so any native modules still get rebuilt for arm64.
  buildDependenciesFromSource: false
};
