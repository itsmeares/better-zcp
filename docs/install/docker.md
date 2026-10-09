# Docker install guide

One image, `ghcr.io/itsmeares/better-zcp`, serves two setups. They are not
interchangeable, so read the table first.

## Which path is mine?

| What you have                                                                                                                                 | Use this path                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Nothing running yet. You want the panel to install and manage game servers.                                                                    | [Managed stack](#path-a-managed-stack)         |
| Project Zomboid already running on **this host** (systemd, screen, tmux, another container) or on another machine, and you want the panel beside it. | [Panel only](#path-b-panel-only)               |
| macOS                                                                                                                                         | Run the panel with Docker Desktop or OrbStack and connect it to a PZ server on Linux using [Path B](#path-b-panel-only). The managed stack needs an amd64 Linux Docker host. |

Every path ends at the web UI on `http://localhost:3001`.

## Image tags

| Tag | Points at | Use it for |
| --- | --- | --- |
| `stable` | Newest release without a prerelease suffix (from 3.0.0 on) | Most installs |
| `latest` | Newest release, release candidates included | Testing RCs |
| `X.Y` | Newest stable patch of that minor release | Patch updates only |
| `X.Y.Z` | One exact release, never rewritten | Pinning and rollbacks |

Both compose files read `BETTER_ZCP_VERSION` from a `.env` file beside them and
default to `latest`. Until 3.0.0 ships there is no `stable` tag. To pin, put
`BETTER_ZCP_VERSION=3.0.0-rc2` (or any exact version) in `.env`.

---

## Path A: Managed stack

**What it is:** a panel container plus one game container per server profile.
The panel mounts the Docker socket to start and stop game containers. Access to
that socket grants host-level Docker control, so use this path only on a host
where you trust the panel administrator with Docker access.

### Install

1. On an amd64 Linux Docker host, install Docker Engine and the Docker Compose
   plugin. Check `docker compose version`.
2. Download the compose file and start it:

   ```sh
   mkdir -p ~/zomboid-panel && cd ~/zomboid-panel
   curl -O https://raw.githubusercontent.com/itsmeares/better-zcp/main/docker-compose.yml
   docker compose up -d
   ```

   The first start installs Project Zomboid with SteamCMD, which takes several
   minutes. SteamCMD sometimes fails its first run while it updates itself; the
   entrypoint retries up to three times.
3. Find the first-run setup token in `docker logs zomboid-panel`, open
   `http://<host>:3001` and create your admin account. Create a server profile,
   set its admin password, and start it from the panel. Its game container
   publishes the profile's UDP server port and the next UDP port. Additional
   profiles need distinct server ports and RCON ports to run at the same time.

The stack keeps its data in four named volumes: `better-zcp_panel-data`,
`better-zcp_panel-logs`, `better-zcp_pz-server` (the game install) and
`better-zcp_zomboid-data` (saves and config). `CORS_ORIGINS` is only needed
when browsers reach the panel through a public hostname; see
[CORS_ORIGINS](#cors_origins-when-accessed-from-anywhere-other-than-localhost).

### Update

Take a full backup first. In the folder with your `docker-compose.yml`:

```sh
docker compose up -d --pull always --no-deps panel
```

This recreates only the panel container, so running game containers stay
online. If `.env` pins an exact version, change `BETTER_ZCP_VERSION` there
first, or prefix the command with `BETTER_ZCP_VERSION=<version>` and edit `.env`
afterwards so later restarts keep it. Settings shows the same command.

### Moving from the 3.0.0-rc1 or rc2 managed stack

The release that replaced the RC installer renamed the named volumes and removed
`bootstrap.sh`, so this update is manual. Your data stays in the old `ctx_*`
volumes until you copy it, and the copy never changes or removes them.

1. Back up from **Settings**, then save and stop every game in the panel.
2. Stop the old stack without deleting volumes. Its compose file is in
   `<state dir>/build/ctx`, normally `~/.local/state/zomboid-panel/build/ctx`
   (`PANEL_HOME` or `BUILD_ROOT` can change that):

   ```sh
   cd ~/.local/state/zomboid-panel/build/ctx
   docker compose --env-file .env down
   ```

   Do not add `-v`.
3. Remove the old game containers. The panel recreates them from your profiles:

   ```sh
   docker ps -a --filter name=zomboid-game- --format '{{.Names}}'
   docker rm $(docker ps -aq --filter name=zomboid-game-)
   ```
4. Download the new files and copy the volumes:

   ```sh
   mkdir -p ~/zomboid-panel && cd ~/zomboid-panel
   curl -O https://raw.githubusercontent.com/itsmeares/better-zcp/main/docker-compose.yml
   curl -O https://raw.githubusercontent.com/itsmeares/better-zcp/main/docker/migrate-rc-volumes.sh
   sh migrate-rc-volumes.sh
   ```

   The script refuses to start while any container still uses an old volume,
   refuses to write into a new volume that already has files, and compares
   every copied volume with its source. Wait for `OK` on all four.
5. Start the new stack with `docker compose up -d`, then start your games from
   the panel. Profiles and settings come from the copied panel database.
6. Remove the old `ctx_*` volumes yourself once the new stack has run well. The
   old `aio-3.0.0-rc*` images stay on GHCR, so an untouched RC stack keeps
   working.

---

## Path B: Panel only

**What it is:** the panel alone, for a Project Zomboid install that already
exists on this host or is reachable over a network share. Use this when you need
the panel to edit PZ's config files, take local backups, or install the game
integration, and PZ isn't in the same container as the panel.

### Phase 1: Prerequisites

1. Docker Engine **and** the Docker Compose plugin (`docker compose version`
   prints a version).
2. Project Zomboid installed somewhere the panel can reach: on this host, or
   over RCON to another machine or container. A network share must be mounted on
   the host first.
3. If bind-mounting PZ folders: the numeric user and group that own them. Run
   `id -u` and `id -g` as the user PZ runs as.

### Phase 2: Download the files

```sh
mkdir -p ~/zomboid-panel && cd ~/zomboid-panel
curl -O https://raw.githubusercontent.com/itsmeares/better-zcp/main/docker-compose.panel-only.yml
curl -o .env https://raw.githubusercontent.com/itsmeares/better-zcp/main/.env.example
```

### Phase 3: Edit before first start

4. In `.env`, set `PUID` and `PGID` to the values from step 3 (see
   [PUID/PGID](#puidpgid-on-bind-mounted-pz-folders)).
5. In `docker-compose.panel-only.yml`, uncomment the two bind-mount lines under
   `volumes` and point their left side at your real Project Zomboid install and
   `Zomboid` data folders.
6. If the panel will be reached through a reverse proxy or a domain name, see
   [CORS_ORIGINS](#cors_origins-when-accessed-from-anywhere-other-than-localhost).

### Optional: let the panel control a PZ container

The panel can start, stop and restart a Project Zomboid container on the same
Docker host. This is opt-in: mounting `docker.sock` gives the panel control
over every container on that host.

1. In `.env`, set:
   ```dotenv
   PANEL_DOCKER_CONTROL_ENABLED=true
   DOCKER_GID=999
   ```
   Replace `999` with the numeric group that owns the host socket:
   `stat -c '%g' /var/run/docker.sock`.
2. In `docker-compose.panel-only.yml`, uncomment the Docker socket volume and
   the `group_add` block. The supplementary group is required when the panel's
   `PUID`/`PGID` is not already allowed to read and write the socket.
3. Add the management label to the PZ container. In Compose, add this to the PZ
   service and recreate it:
   ```yaml
   labels:
     zomboid-panel.managed: "true"
   ```
   For an existing container: `docker update --label-add zomboid-panel.managed=true <pz-container>`.
4. In **Servers**, put the PZ container's name or ID in **Docker container** on
   the server profile. Use the Compose service name when the panel and PZ share
   a Docker network.

**You know it worked when:** the Docker page lists the labeled container, the
server profile shows its container name, and Start/Stop uses the container
lifecycle instead of sending RCON `quit` to PID 1. If the Docker page says the
daemon is unavailable, check the socket mount and the numeric socket group
before changing the PZ configuration.

### Phase 4: Start it

```sh
docker compose -f docker-compose.panel-only.yml up -d
```

**You know it worked when:** `docker compose ps` shows `zomboid-panel` as
`Up (healthy)`, and `curl -s http://localhost:3001/api/health` returns 200.

### Phase 5: First login

7. Open `http://localhost:3001`. The setup screen asks for a **Setup Token**.
   Get it from the logs:
   ```sh
   docker compose -f docker-compose.panel-only.yml logs panel | grep "SETUP TOKEN"
   ```
   Paste the long string after `SETUP TOKEN required to complete first-run
   setup:`, then choose a username and password.
8. In **Settings**, set the server install path and Zomboid data path to the
   **container-side** paths from your volumes block (for example `/pz-server`
   and `/zomboid`), never the host paths on the left of the `:`.
9. Configure RCON (host, port, password from your server `.ini`); see
   [README, Setup](../../README.md#setup). If Project Zomboid runs in a
   **separate container**, don't use `127.0.0.1` as the RCON host. Inside the
   panel container that address means the panel itself, and the failure looks
   like a bad password or port. Put both containers on the same user-defined
   Docker network and enter the PZ container's service name (for example
   `pzserver`) as the RCON host.

**You know it worked when:** the dashboard shows the server status card and RCON
shows connected.

### Update

```sh
docker compose -f docker-compose.panel-only.yml up -d --pull always --no-deps panel
```

If `.env` pins an exact `BETTER_ZCP_VERSION`, change it first. Building from
source is not wired into the compose files; build the root `Dockerfile` yourself
and set `BETTER_ZCP_VERSION` to the tag you gave it.

---

## The two things that actually bite

### PUID/PGID on bind-mounted PZ folders

This applies to **Path B** only. It does **not** apply to **Path A**, where the
stack uses named volumes it owns itself, always as UID/GID `1000`.

The image starts as root and re-owns exactly two directories to the numeric
UID/GID: `/app/data` and `/app/logs` (its own state). It never touches the
ownership of your PZ install or save mounts. If `PUID`/`PGID` don't match the
owner of those bind-mounted folders, PZ config edits or game integration
installation fail with permission errors, because the panel process has no write
access to your real PZ folders.

Fix it:

```sh
id -u   # your PUID
id -g   # your PGID
```

Put those values in `.env`, then run `docker compose -f docker-compose.panel-only.yml up -d`.
No rebuild is needed: the image applies `PUID`/`PGID` at container start.

One exception: if the container is launched with a UID already pinned (for
example a Kubernetes pod with `runAsUser`/`runAsGroup`/`runAsNonRoot: true`), it
cannot `chown` anything and skips the step. `PUID`/`PGID` are then ignored, and
`/app/data` and `/app/logs` must already be writable by that UID.

### CORS_ORIGINS when accessed from anywhere other than localhost

The panel auto-allows any local or LAN address (`localhost`, `127.0.0.1`,
`192.168.x.x`, `10.x.x.x`, and similar private ranges) without configuration.
You only need `CORS_ORIGINS` when the browser reaches the panel through
something that **isn't** a private address, most commonly a public hostname
behind a reverse proxy.

Symptom if you skip this: requests from the browser return HTTP 403 with
`Origin blocked by panel CORS policy`, and the panel logs the blocked origin.
Requests without an `Origin` header, such as a basic `curl` health check, still
work.

Set the **exact** origin the browser uses (scheme, host, and port if
non-default), comma-separated if there is more than one. Put it in the `.env`
file beside the compose file, for example:

```dotenv
CORS_ORIGINS=https://panel.example.com
```

If the browser uses another port, include it, for example
`CORS_ORIGINS=https://panel.example.com:8443`. Then recreate the panel:

```sh
docker compose up -d
```

(Use `-f docker-compose.panel-only.yml` on Path B.) Once you're logged in you
can also manage allowed origins in **Settings → Remote Access**. The environment
variable exists to solve the chicken-and-egg problem of not being able to reach
Settings while CORS blocks you.

## Automating first-run setup

Both paths have you grab the **Setup Token** from the container logs after first
start. If you're scripting the deployment (CI, Ansible, a provisioning tool) and
nothing is watching those logs, set `SETUP_TOKEN` to a value you choose *before*
the first start instead. The panel uses it directly and skips generating and
printing its own:

```yaml
environment:
  SETUP_TOKEN: a-value-only-your-script-knows
```

Treat it exactly like the printed token: whoever presents it first creates the
admin account. It only matters before the first account exists; once setup is
complete, the panel ignores it.
