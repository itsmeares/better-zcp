#!/bin/sh
# One-time move of a 3.0 RC managed stack's data into the volumes used by
# docker-compose.yml. Copies; never changes or removes the old volumes.
# Usage: sh migrate-rc-volumes.sh [image]
set -eu

OLD_PREFIX="${OLD_VOLUME_PREFIX:-ctx}"
NEW_PREFIX="better-zcp"
VOLUMES="panel-data panel-logs pz-server zomboid-data"
IMAGE="${1:-ghcr.io/itsmeares/better-zcp:${BETTER_ZCP_VERSION:-latest}}"

fail() { echo "$*" >&2; exit 1; }

docker info >/dev/null 2>&1 || fail "Docker is not available to this user."

missing=""
busy=""
for name in $VOLUMES; do
  old="${OLD_PREFIX}_${name}"
  docker volume inspect "$old" >/dev/null 2>&1 || missing="$missing $old"
  users="$(docker ps -a --filter "volume=$old" --format '{{.Names}}' 2>/dev/null | paste -sd' ' -)"
  [ -z "$users" ] || busy="$busy\n  $old is used by: $users"
done
[ -z "$missing" ] || fail "Missing old volumes:$missing
Run 'docker volume ls' to find your RC volumes. If they use another prefix, rerun with OLD_VOLUME_PREFIX=<prefix>."
[ -z "$busy" ] || fail "Stop and remove these containers first (docker compose down on the old stack, then docker rm the zomboid-game-* containers):$(printf "$busy")"

# Mount point /v is the volume root, so hidden files count too.
fingerprint() {
  docker run --rm --entrypoint sh -v "$1:/v:ro" "$IMAGE" -c \
    "cd /v && find . -printf '%P %s %U:%G %m\n' | sort | cksum"
}

for name in $VOLUMES; do
  old="${OLD_PREFIX}_${name}"
  new="${NEW_PREFIX}_${name}"
  if docker volume inspect "$new" >/dev/null 2>&1; then
    in_use="$(docker run --rm --entrypoint sh -v "$new:/v:ro" "$IMAGE" -c 'ls -A /v | head -n 1')"
    [ -z "$in_use" ] || fail "$new already has files. Nothing was copied. Remove it with 'docker volume rm $new' only if you are sure it holds nothing you need."
  fi
done

for name in $VOLUMES; do
  old="${OLD_PREFIX}_${name}"
  new="${NEW_PREFIX}_${name}"
  docker volume inspect "$new" >/dev/null 2>&1 || docker volume create \
    --label "com.docker.compose.project=$NEW_PREFIX" \
    --label "com.docker.compose.volume=$name" "$new" >/dev/null
  echo "Copying $old to $new ..."
  docker run --rm --entrypoint sh -v "$old:/from:ro" -v "$new:/to" "$IMAGE" -c 'cp -a /from/. /to/'
  if [ "$(fingerprint "$old")" = "$(fingerprint "$new")" ]; then
    echo "  OK: $new matches $old."
  else
    fail "  FAILED: $new does not match $old. Remove $new with 'docker volume rm $new' and run this script again. The old volume is untouched."
  fi
done

echo
echo "All volumes copied and checked. The old ${OLD_PREFIX}_* volumes are untouched; remove them yourself once the new stack has run well."
echo "Next: docker compose up -d"
