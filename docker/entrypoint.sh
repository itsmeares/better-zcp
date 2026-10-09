#!/bin/sh
set -eu

puid="${PUID:-1000}"
pgid="${PGID:-1000}"
managed=false
[ "${PANEL_MANAGED_GAMES:-}" = "true" ] && managed=true

case "$puid:$pgid" in
  *[!0-9:]* | :* | *:)
    echo "PUID and PGID must be numeric values" >&2
    exit 64
    ;;
esac

if [ "$(id -u)" != "0" ]; then
  if [ "$managed" = true ]; then
    echo "PANEL_MANAGED_GAMES needs a root start: the entrypoint chowns the game volumes and installs the game before dropping privileges." >&2
    exit 1
  fi
  current_uid="$(id -u)"
  current_gid="$(id -g)"
  if [ "$current_uid:$current_gid" != "$puid:$pgid" ]; then
    echo "Running as $current_uid:$current_gid; ignoring PUID/PGID $puid:$pgid" >&2
  fi
  echo "Not running as root: skipping chown and privilege drop." >&2
  echo "Ensure /app/data and /app/logs are writable by $current_uid:$current_gid." >&2
  mkdir -p /app/data /app/logs 2>/dev/null || true
  exec "$@"
fi

mkdir -p /app/data /app/logs
chown -R "$puid:$pgid" /app/data /app/logs

supplementary="$(id -G | tr ' ' '\n' | grep -vx '0' | grep -vx "$pgid" | paste -sd, -)"

if [ "$managed" = true ]; then
  steamcmd=/home/steam/steamcmd/steamcmd.sh
  if [ ! -x "$steamcmd" ]; then
    echo "steamcmd is missing from this image. Managed games need an amd64 image." >&2
    exit 1
  fi

  export HOME=/home/steam
  mkdir -p /pz-server /zomboid
  chown -R "$puid:$pgid" /home/steam
  chown "$puid:$pgid" /pz-server /zomboid

  if [ -S /var/run/docker.sock ]; then
    socket_gid="$(stat -c '%g' /var/run/docker.sock)"
    supplementary="${supplementary:+$supplementary,}$socket_gid"
  fi

  if [ ! -f /pz-server/start-server.sh ]; then
    echo "[entrypoint] No Project Zomboid install in /pz-server; installing with steamcmd..."
    attempt=1
    # steamcmd often fails its first run while it updates itself, so retry.
    until setpriv --reuid="$puid" --regid="$pgid" --clear-groups \
      "$steamcmd" +force_install_dir /pz-server +login anonymous +app_update 380870 validate +quit; do
      if [ "$attempt" -ge 3 ]; then
        echo "[entrypoint] steamcmd failed $attempt times; giving up." >&2
        exit 1
      fi
      attempt=$((attempt + 1))
      echo "[entrypoint] steamcmd failed; retrying (attempt $attempt of 3)..." >&2
      sleep 5
    done
  else
    echo "[entrypoint] Existing Project Zomboid install found in /pz-server."
  fi
  chmod +x /pz-server/start-server.sh 2>/dev/null || true
fi

if [ -n "$supplementary" ]; then
  echo "Preserving supplementary groups: $supplementary" >&2
  exec setpriv --reuid="$puid" --regid="$pgid" --groups "$supplementary" "$@"
fi

exec setpriv --reuid="$puid" --regid="$pgid" --clear-groups "$@"
