#!/bin/sh
set -eu

puid="${PUID:-1000}"
pgid="${PGID:-1000}"

case "$puid:$pgid" in
  *[!0-9:]* | :* | *:)
    echo "PUID and PGID must be numeric values" >&2
    exit 64
    ;;
esac

if [ "$(id -u)" != "0" ]; then
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

if [ -n "$supplementary" ]; then
  echo "Preserving supplementary groups: $supplementary" >&2
  exec setpriv --reuid="$puid" --regid="$pgid" --groups "$supplementary" "$@"
fi

exec setpriv --reuid="$puid" --regid="$pgid" --clear-groups "$@"
