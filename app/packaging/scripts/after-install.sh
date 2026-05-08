#!/bin/sh
# Post-install hook for the trailcurrent-playbill .deb.
# electron-builder runs this with root privileges after dpkg lays down /opt/.

set -e

# Refresh the desktop database so GNOME picks up the launcher immediately.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi

# Refresh the icon cache so the launcher icon shows up in the dock without a relog.
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
fi

exit 0
