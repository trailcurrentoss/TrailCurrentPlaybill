# TrailCurrent Playbill — branded shell prompt
# Sourced by /etc/profile via /etc/profile.d/

if [ -n "${BASH_VERSION:-}" ] && [ -t 0 ]; then
    PS1='\[\033[38;5;70m\]trail\[\033[38;5;30m\]current\[\033[0m\]@\[\033[38;5;70m\]\h\[\033[0m\]:\w\$ '
fi

# Convenience aliases
alias playbill-launch='gtk-launch trailcurrent-playbill || /opt/trailcurrent-playbill/trailcurrent-playbill --no-sandbox'
alias playbill-logs='journalctl --user -u trailcurrent-playbill -f 2>/dev/null || true'
