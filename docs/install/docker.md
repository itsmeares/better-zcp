# Docker Install Guide

This repo ships **three** Docker paths. They are not interchangeable — each
assumes a different starting point. Read the table below first; it takes one
read to know which walkthrough is yours.

If you get lost partway through, jump back to the table — nothing here
assumes you've read the others.

## Which path is mine?

| What you already have                                                                                                                                                                     | Use this path                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Nothing running yet. You want the panel to install and manage game servers. | [Managed stack](#path-a-managed-stack) — separate panel and game containers |
| Project Zomboid already running on **this same host** (systemd, screen, tmux, another container) and you want the panel to edit its config files, take local backups, or use PanelBridge. | [docker-compose.yml](#path-b-docker-composeyml-bind-mounts) — bind mounts, full file access       |
| **Unraid**, with Project Zomboid already running in its own container/template.                                                                                                           | [Unraid template](#path-c-unraid) — panel with the PZ folders mounted                             |
| macOS | Run the panel with Docker Desktop or OrbStack and connect it to a PZ server on Linux using [Path B](#path-b-docker-composeyml-bind-mounts). The managed stack requires an amd64 Linux Docker host. |

Every path ends with the same web UI at `http://localhost:3001` — only how
Project Zomboid gets there differs.

---

## Path A: Managed stack

**What it is:** a panel container and one game container per server profile.
The panel mounts the Docker socket to start and stop game containers. Access to
that socket grants host-level Docker control, so use this path only on a host
where you trust the panel administrator with Docker access.

### Install

1. On an amd64 Linux Docker host, install Docker Engine, the Docker Compose
   plugin, `curl`, and `tar`. Check `docker compose version` before proceeding.
2. Run:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/itsmeares/better-zcp/main/infra/docker/all-in-one/bootstrap.sh | sh
   ```

   To select a release, add a version after `sh -s --`, such as `2.0.0`.
   The script downloads that release's source, pulls its exact image tag when
   available, and otherwise builds from source. It keeps named volumes for
   panel state, logs, the PZ install, and saves. It waits for the panel health
   check before reporting success.
3. Find the first-run setup token in `docker logs zomboid-panel`, then open
   the printed panel URL and complete setup. Create a server profile, set its
   admin password, and start it from the panel. Its game container publishes
   the profile's UDP server port and the next UDP port. Additional profiles
   need distinct server ports and RCON ports to run at the same time.

The stack's `.env` is in `<state dir>/build/ctx/.env`, normally
`~/.local/state/zomboid-panel/build/ctx/.env`. `PANEL_HOME` and `BUILD_ROOT`
can change that location. The installer generates a local CORS origin on the
first run and preserves an existing `.env` on later runs.

### Update

Settings reports newer releases and shows the host command for the selected
version. Take a full backup before updating. The command recreates only the
panel container; running game containers stay online. Run it on the Docker
host with the same `PANEL_HOME` or `BUILD_ROOT` value used at install time.

The first update from the older combined container requires stopping the game
once. The installer refuses to split it while the old game process is running.
It keeps the four named volumes, existing profiles, game install, and saves.
Later panel updates leave game containers running. The obsolete updater
service is removed by Compose.

---

## Path B: docker-compose.yml (bind mounts)

**What it is:** the panel only, with commented-out bind-mount examples for a
Project Zomboid install that already exists on this host or is reachable
over a network share. Use this when you need the panel to edit PZ's config
files, take local backups, or use PanelBridge, and PZ isn't in the same
container as the panel.

### Phase 1 — Prerequisites

1. Docker Engine **and** the Docker Compose plugin (`docker compose version`
   should print a version).
2. Project Zomboid already installed somewhere the panel can reach — on this
   host, or over RCON to another machine/container.
3. If bind-mounting PZ folders on this host: know the numeric user/group
   that owns them. Run `id -u` and `id -g` as the user PZ runs as.

**You know it worked when:** `docker compose version` prints without error.

### Phase 2 — Download the files

4. ```sh
   mkdir -p ~/zomboid-panel && cd ~/zomboid-panel
   curl -O https://raw.githubusercontent.com/itsmeares/better-zcp/main/docker-compose.yml
   curl -O https://raw.githubusercontent.com/itsmeares/better-zcp/main/.env.example
   mv .env.example .env
   ```

**You know it worked when:** `ls` in that directory shows both
`docker-compose.yml` and `.env`.

### Phase 3 — Edit before first start

5. Open `.env` and set `PUID`/`PGID` to the values from step 3 (see
   [PUID/PGID](#puidpgid-on-bind-mounted-pz-folders) below for why this
   matters).
6. Open `docker-compose.yml` and uncomment the volume lines for your
   topology (PZ on this host, or PZ reachable over NFS/SMB) — the file has
   both examples annotated inline. Point them at your real PZ install and
   `Zomboid` data folders.
7. If the panel will be reached from anywhere other than `localhost` (a
   reverse proxy, a domain name), also see
   [CORS_ORIGINS](#cors_origins-when-accessed-from-anywhere-other-than-localhost)
   below before continuing.

### Optional: let the panel control a PZ container

Path B can start, stop, and restart a Project Zomboid container on the same
Docker host. This is deliberately opt-in: mounting `docker.sock` gives the
panel control over every container on that host.

Before `docker compose up -d`:

1. In `.env`, set:
   ```dotenv
   PANEL_DOCKER_CONTROL_ENABLED=true
   DOCKER_GID=999
   ```
   Replace `999` with the numeric group that owns the host socket:
   `stat -c '%g' /var/run/docker.sock`.
2. In `docker-compose.yml`, uncomment the Docker socket volume and the
   `group_add` block. The supplementary group is required when the panel's
   `PUID`/`PGID` is not already allowed to read and write the socket.
3. Add the management label to the PZ container. For Compose, add this to
   the PZ service and recreate it:
   ```yaml
   labels:
     zomboid-panel.managed: "true"
   ```
   For an existing container, the equivalent one-time command is:
   ```sh
   docker update --label-add zomboid-panel.managed=true <pz-container>
   ```
4. In **Servers**, put the PZ container's name or ID in **Docker container**
   on the server profile. Use the Compose service/container name when the
   panel and PZ share a Docker network.

**You know it worked when:** the Docker page lists the labeled container,
the server profile shows its container name, and Start/Stop uses the
container lifecycle instead of sending RCON `quit` to PID 1. If the Docker
page says the daemon is unavailable, check the socket mount and the numeric
socket group before changing the PZ configuration.

**You know it worked when:** rereading the volumes block, the left side of
each `:` is a real path on this machine, not a placeholder.

### Phase 4 — Start it

8. ```sh
   docker compose up -d
   ```

**You know it worked when:** `docker compose ps` shows `zomboid-panel` as
`Up (healthy)`, and `curl -s http://localhost:3001/api/health` returns
`{"status":"ok"...}` (exact fields may vary; a 200 response is what matters).

### Phase 5 — First login

9. Open `http://localhost:3001`. You'll see a setup screen asking for a
   **Setup Token** — get it from the container's logs:
   ```sh
   docker compose logs zomboid-panel | grep "SETUP TOKEN"
   ```
   Copy the long string after `SETUP TOKEN required to complete first-run
   setup:` and paste it into the setup screen, then choose a username and
   password and submit.
10. In **Settings**, set the server install path and Zomboid data path to
    the **container-side** paths from your volumes block (for example
    `/pz-server` and `/zomboid`), never the host paths on the left side of
    the `:`.
11. Configure RCON (host, port, password from your server `.ini`) — see
    [README — Setup](../../README.md#setup). If Project Zomboid runs in a
    **separate container** rather than on the host directly, don't use
    `127.0.0.1` as the RCON host — inside the panel container that address
    means the panel container itself, and the connection fails in a way
    that looks like a bad RCON password or port rather than a topology
    mistake. Put both containers on the same user-defined Docker network,
    then enter the PZ container's Compose **service name** (for example
    `pzserver`) as the RCON host instead.

**You know it worked when:** the dashboard shows the server status card and
RCON shows connected.

### Notes specific to this path

- **Published image vs. build from source:** `docker-compose.yml` already
  has both `image:` and `build:` set — there's nothing to edit either way.
  `docker compose up -d` tries to pull `ghcr.io/itsmeares/better-zcp:latest`
  first; if that fails (no tagged release yet, or a private fork without
  GHCR access), it builds from source automatically and tags the result the
  same, so later `up -d` runs won't try to pull again. Each tagged release
  also publishes a version-pinned image with a matching name (for example
  `ghcr.io/itsmeares/better-zcp:2.0.0` — no `v` prefix, unlike the git tag
  it's built from), if you'd rather pin a version than track `:latest`.

---

## Path C: Unraid

**What it is:** a Community Applications template that runs the panel
**only**, alongside a Project Zomboid container you already have (for
example from Indifferent Broccoli or a community PZ template). It does not
install or run Project Zomboid itself.

### Phase 1 — Prerequisites

1. An existing PZ container/template on the same Unraid box, with its host
   paths for the PZ install and PZ config/save data noted down.

### Phase 2 — Import and configure

2. In Unraid's **Docker** tab, add the container from template:
   `https://raw.githubusercontent.com/itsmeares/better-zcp/main/infra/docker/unraid/zomboid-panel.xml`
   (or search "Zomboid Control Panel" if it's listed in Community
   Applications).
3. Set these four path mappings — the panel's own two are pre-filled, the
   PZ two must be changed to match your PZ container's template:

   | Field | Target | Set it to |
   | --- | --- | --- |
   | Panel data | `/app/data` | Leave as `/mnt/user/appdata/zomboid-panel/data` (or your preference) — this is the panel's own database, not PZ's |
   | Panel logs | `/app/logs` | Leave as `/mnt/user/appdata/zomboid-panel/logs` (or your preference) |
   | PZ install | `/pz-server` | The **install** path from your existing PZ container's template |
   | PZ user data | `/zomboid` | The **config/saves** path from your existing PZ container's template |

4. Set `PUID`/`PGID` to match the owner used by your PZ container (Unraid
   defaults `99`/`100` are pre-filled — change them if your PZ container
   uses different values).
5. Set `RCON host`: the PZ container's name if both are on the same
   user-defined Docker network, otherwise its fixed LAN address. **Never**
   `127.0.0.1` — inside the panel container that means the panel itself, not
   your PZ container. Set `RCON port` and `RCON password` to match your PZ
   server's `.ini`.
6. Apply.

**You know it worked when:** the container shows started (green) in the
Docker tab, and clicking its icon opens the panel WebUI on the port you
configured.

### Phase 3 — First login

7. Open the WebUI. You'll see a setup screen asking for a **Setup Token** —
   get it from the container's logs: in Unraid's **Docker** tab, click the
   panel container's icon → **Logs**, and find the line starting `SETUP
   TOKEN required to complete first-run setup:`. Copy the long string after
   it and paste it into the setup screen, then choose a username and
   password and submit.
8. In **Settings**, set the paths to the **container-side** values —
   `/pz-server` and `/zomboid` — never the `/mnt/...` host paths from step 3.
   **You know it worked when:** the dashboard shows the server status card and
   RCON shows connected. By default, the panel can monitor and administer the
   game through RCON, but it does not start, stop, or auto-update a PZ container
   owned by Unraid.

### Optional: let the panel control the Unraid PZ container

Only enable this when you want the panel to own the container lifecycle
instead of Unraid. In the Unraid template editor:

1. Add a bind mount from the host `/var/run/docker.sock` to the container
   `/var/run/docker.sock` with read/write access.
2. Add the environment variable `PANEL_DOCKER_CONTROL_ENABLED=true`.
3. Add the Docker socket's numeric group to the container's **Extra
   Parameters**, for example `--group-add=281`. Find the real value on the
   Unraid host with `stat -c '%g' /var/run/docker.sock`; do not assume the
   example value.
4. Add the label `zomboid-panel.managed=true` to the existing PZ container
   and put that container's name in the panel's **Docker container** field.

The Docker socket is equivalent to host-level container control, so leave
this disabled unless the panel is trusted. If it is enabled but the Docker
page still reports the daemon as unavailable, check the socket mount and
the supplementary group first.

---

## The two things that actually bite

### PUID/PGID on bind-mounted PZ folders

This applies to **Path B** and **Path C** — anywhere the panel bind-mounts a
PZ folder that already exists on the host, owned by a specific Linux
user/group. It does **not** apply to **Path A** (the managed stack uses named
volumes it owns itself, always as UID/GID `1000` internally).

The container image runs as root by default and re-owns exactly two
directories to a numeric UID/GID: `/app/data` and `/app/logs` (its own
state). It never touches the ownership of your PZ install or save mounts.
If `PUID`/`PGID` don't match the actual owner of those bind-mounted PZ
folders, one of two things happens:

- **The panel's own directories are wrong** (rare) — you set `PUID`/`PGID`
  to something other than the account you plan to use, and Docker-managed
  volumes come up owned by that value instead. Docker manages
  `panel-data`/`panel-logs` volumes itself, so this is usually only visible
  if you replaced them with host bind mounts.
- **PZ config edits or PanelBridge file access fail with permission
  errors** (the actual failure mode) — the panel process is running as a
  UID/GID that doesn't have write access to your real PZ folders, because
  `PUID`/`PGID` didn't match the account that owns them on the host.

Fix it:
```sh
id -u   # your PUID
id -g   # your PGID
```
Put those values in `.env`, then restart:
```sh
docker compose up -d
```
No rebuild needed — the published image applies `PUID`/`PGID` at container
start, not at build time.

One exception: if the container is launched with a UID already pinned (for
example a Kubernetes pod with `runAsUser`/`runAsGroup`/`runAsNonRoot:
true`), it has no permission to `chown` anything and skips the step
entirely — in that case `PUID`/`PGID` are ignored, and `/app/data` and
`/app/logs` must already be writable by whatever UID the pod was given.

### CORS_ORIGINS when accessed from anywhere other than localhost

The panel auto-allows any local or LAN address (`localhost`, `127.0.0.1`,
`192.168.x.x`, `10.x.x.x`, and similar private ranges) without any
configuration. You only need `CORS_ORIGINS` when the browser reaches the
panel through something that **isn't** a private address — a public
hostname behind a reverse proxy, most commonly.

Symptom if you skip this: requests from the browser can return HTTP 403 with
`Origin blocked by panel CORS policy`; the panel logs the blocked origin.
Requests without an `Origin` header, such as a basic `curl` health check,
can still work.

Fix it — set the **exact** origin the browser uses (scheme, host, and port
if non-default), comma-separated if there's more than one. Once you're
logged in, you can also manage allowed origins from **Settings → Remote
Access** instead — the environment variable exists specifically to solve the
chicken-and-egg problem of not being able to reach Settings if CORS is
already blocking you. **Where you set it, and how you apply it, is different
per path** — the variable name is the same everywhere:

- **Path A (managed stack):** already wired. It lives in a different file —
  `<state dir>/build/ctx/.env` (default:
  `~/.local/state/zomboid-panel/build/ctx/.env`) — and defaults to
  `http://localhost:3001` plus your detected LAN address when the installer
  first creates it. Edit it there, then re-run the bootstrap command to apply
  the change without stopping the game.
- **Path B (docker-compose.yml or docker-compose.install.yml):** set the
  variable in the `.env` file beside the compose file. For example, when a
  reverse proxy exposes the panel at its default HTTPS port:
  ```dotenv
  CORS_ORIGINS=https://panel.example.com
  ```
  If the browser uses another port, include it, for example
  `CORS_ORIGINS=https://panel.example.com:8443`. Another hostname or port
  needs its own comma-separated entry. Then apply it:
  ```sh
  docker compose up -d
  ```
- **Path C (Unraid):** already wired — it's the **CORS origins** field under
  the template's advanced settings (blank by default, LAN-only). Expand
  "Show more settings" if you don't see it.

Restart or recreate the panel container for the change to
take effect.

## Automating first-run setup

Every path above has you grab the **Setup Token** by grepping it out of the
container logs after first start. If you're scripting the deployment (CI,
Ansible, a provisioning tool) and nothing is watching those logs, set
`SETUP_TOKEN` to a value you choose *before* the first start instead — the
panel uses it directly and skips generating and printing its own:

```yaml
environment:
  SETUP_TOKEN: a-value-only-your-script-knows
```

Treat it exactly like the printed token would be — whoever presents it
first creates the admin account. It only matters before that first account
exists; once setup is complete, the panel ignores it.
