#!/bin/sh
set -eu

INSTALL_DIR=/opt/zomboid-panel
UNIT_SOURCE="$INSTALL_DIR/zomboid-panel.service"
UNIT_TARGET=/etc/systemd/system/zomboid-panel.service
SERVICE_USER=pzuser
ENABLE_SERVICE=0

usage() {
  printf '%s\n' \
    "Usage: sudo ./install-linux-service.sh [--enable]" \
    "" \
    "Installs the bundled systemd unit for /opt/zomboid-panel." \
    "The script never invokes sudo itself and never updates the panel binary."
}

for argument in "$@"; do
  case "$argument" in
    --enable) ENABLE_SERVICE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' "ERROR: Run this installer explicitly as root (for example with sudo)." >&2
  exit 1
fi

if [ ! -x "$INSTALL_DIR/ZomboidControlPanel" ]; then
  printf 'ERROR: %s/ZomboidControlPanel is missing or not executable.\n' "$INSTALL_DIR" >&2
  exit 1
fi
if [ ! -f "$INSTALL_DIR/start.sh" ] || [ ! -f "$UNIT_SOURCE" ]; then
  printf 'ERROR: start.sh and zomboid-panel.service must be present in %s.\n' "$INSTALL_DIR" >&2
  exit 1
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  printf 'ERROR: service user %s does not exist. Create it before installing the unit.\n' "$SERVICE_USER" >&2
  exit 1
fi

chmod 0755 "$INSTALL_DIR/start.sh" "$INSTALL_DIR/ZomboidControlPanel"

if [ -f "$UNIT_TARGET" ]; then
  if cmp -s "$UNIT_SOURCE" "$UNIT_TARGET"; then
    printf '%s\n' "The installed systemd unit is already current."
  else
    BACKUP="$UNIT_TARGET.backup-$(date +%Y%m%d-%H%M%S)"
    cp -p "$UNIT_TARGET" "$BACKUP"
    printf 'Backed up the existing unit to %s.\n' "$BACKUP"
    install -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
  fi
else
  install -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
fi

systemctl daemon-reload
if [ "$ENABLE_SERVICE" -eq 1 ]; then
  systemctl enable --now zomboid-panel.service
  printf '%s\n' "Installed, enabled, and started zomboid-panel.service."
else
  printf '%s\n' "Installed zomboid-panel.service without enabling or restarting it."
  printf '%s\n' "Run: systemctl enable --now zomboid-panel.service"
fi
