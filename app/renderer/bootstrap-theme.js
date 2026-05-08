/* Theme bootstrap. Reacts to GNOME (or browser) light/dark preference and
   keeps document.documentElement.dataset.theme in sync. */

(function () {
  function apply(isDark) {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  }

  // 1) Initial paint — prefer Electron's nativeTheme via preload bridge,
  //    fall back to prefers-color-scheme so the page works in a plain browser.
  var initial = (window.playbill && window.playbill.shouldUseDarkColors !== undefined)
    ? window.playbill.shouldUseDarkColors
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  apply(initial);

  // 2) Live updates from main when GNOME flips Style.
  if (window.playbill && window.playbill.onThemeChange) {
    window.playbill.onThemeChange(apply);
  }

  // 3) Browser-only fallback for `npm start` smoke tests outside Electron.
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', function (e) {
      if (!window.playbill) apply(e.matches);
    });
})();
