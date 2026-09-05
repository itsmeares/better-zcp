# All-in-One Docker Deployment

One container runs the panel, SteamCMD, and the Project Zomboid dedicated
server together. This is what the maintainer runs in production, and the
most complete Docker path in this repo — pick it when you don't have a PZ
server running anywhere yet.

For the full walkthrough with verification checkpoints at every step, plus
how this path compares to the other two Docker paths, see
[`docs/install/docker.md`](../../docs/install/docker.md#path-a-all-in-one).
This file is the short version.

## Prerequisites

A Linux host with Docker Engine installed, an amd64/x86_64 architecture, and
`curl` available. The installer checks all three itself and exits with a
clear message if one is missing, rather than failing confusingly partway
through. The Docker Compose plugin is **not** required on the host — the
installer runs Compose inside its own controller container.

## First install

Run this on the Docker host:

```sh
curl -fsSL https://raw.githubusercontent.com/itsmeares/better-zcp/main/docker/all-in-one/bootstrap.sh | sh
```

To install a specific version instead of the latest release, pass it as an
argument:

```sh
curl -fsSL https://raw.githubusercontent.com/itsmeares/better-zcp/main/docker/all-in-one/bootstrap.sh | sh -s -- 2.0.0
```

The script validates Docker and the host architecture, resolves the latest
GitHub release (unless you passed one), creates its state below
`~/.local/state/zomboid-panel/` by default, generates the updater token,
detects the host's LAN address, and starts the stack. Set `PANEL_HOME` or
`BUILD_ROOT` before running it if you prefer a different host location. It
runs Docker Compose *inside* the controller image, so the host does not need
the Docker Compose plugin.

For the panel and updater images, it pulls the exact release-tagged images
first; if a release image isn't published yet, it builds that image locally
from the downloaded release source instead.

On first start, the container also downloads Project Zomboid itself through
SteamCMD — this can take several minutes. The installer waits for the
panel's own health check (up to 15 minutes) and prints the container's logs
if something goes wrong, so you don't need to watch it, but you can:

```sh
docker logs -f zomboid-panel
```

The installer detects your host's LAN address and includes it in
`CORS_ORIGINS` automatically, so the panel is usually reachable from other
devices on your network with no extra configuration — it prints the URL to
use when it finishes. Reaching it through a reverse proxy or a public
hostname still needs its own origin added: set `CORS_ORIGINS` (and
`TRUST_PROXY`) before running the installer, or edit them in the generated
`.env` file (`<state dir>/build/ctx/.env`) and rerun the script to apply the
change — it won't touch an `.env` that already exists.

The stack uses Docker named volumes for panel state, logs, the PZ
installation, and Zomboid save data. This keeps a default install
independent of a particular NAS or host filesystem layout, and means you
never need to configure `PUID`/`PGID` for this path — the container always
runs Project Zomboid internally as UID/GID `1000` and owns its own volumes.

The Compose stack publishes the PZ game ports `16261/udp` and `16262/udp`
automatically. They do not need to be added to Compose by hand.

The update controller has Docker socket access, but it is not exposed on a
host port. The panel can reach it only over the Compose network using the
token in `.env`.

## Updating

After the first installation, the panel Settings page can apply a newer
GitHub release. The action saves and stops Project Zomboid through RCON,
downloads the tagged source, rebuilds the panel image, recreates only the
panel service, and waits for its health check. A failed rollout restores the
previous source and image.

## Files in this directory

| File | Purpose |
| --- | --- |
| `bootstrap.sh` | Host-side installer — the one command in "First install" above |
| `docker-compose.yml` | The two-service stack (`panel` + `updater`) the installer and the Settings-page updater both run |
| `Dockerfile` | Builds the combined panel + SteamCMD + PZ image |
| `entrypoint.sh` | Container start script: installs PZ via SteamCMD if missing, then starts the panel as the `steam` user |
| `.env.example` | Reference for the variables in the generated `.env` — this path's `.env` is separate from the repo root's `.env.example`, which is for the [bind-mount path](../../docker-compose.yml) instead |
| `updater/` | The `zomboid-panel-updater` service — a small HTTP controller with Docker socket access that performs the rebuild-and-recreate described above |
