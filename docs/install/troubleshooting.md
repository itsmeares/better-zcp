# Troubleshooting

The other guides in this folder tell you what to do. This one is for when
that didn't work.

Part 1 is a checklist to run through **before** you start any install —
having these five things ready up front avoids most of the trouble in Part
2. Part 2 is organized by what you actually **see on screen**: find the
heading that matches your symptom, not the subsystem you think is at fault.
Every heading below quotes real on-screen text — search this page (Ctrl+F)
for a phrase you're looking at and you'll land in the right place.

Several sections below tell you to check the panel's log. If the default log
isn't detailed enough to see what's actually happening, set
`LOG_LEVEL=debug` (in a `.env` file next to the panel `.exe`, in your
`docker-compose.yml`/`.env`, or in the service's environment on Linux) and
restart the panel — this applies everywhere a section below says to check
the log, not just one symptom.

---

## Part 1: Preflight — have these five things ready

Gather these *before* you open the panel for the first time. All five come
from the PZ server `.ini` you're pointing the panel at, or from your own
network — the panel can't discover them for you.

1. **RCON port and password** — from the PZ server's `.ini`:
   ```ini
   RCONPort=27015
   RCONPassword=choose-a-strong-password
   ```
   If the `.ini` doesn't have a password set yet, set one now and restart
   the PZ server before continuing — the panel needs both values to connect
   at all.

2. **The PZ server's install path** — the folder containing the server's
   `.ini`, `ProjectZomboid64` (or `.exe`), and its `Zomboid/` save data (or
   the separate paths for each, if you keep them apart). You'll type this
   into **Settings** or the Setup Wizard.

3. **The Zomboid data path** — where saves, logs, and server config actually
   live (`~/Zomboid` on Linux/macOS, `%USERPROFILE%\Zomboid` on Windows,
   unless you've relocated it with `-Zomboid=...` or `ZomboidINI`).

4. **A free port for the panel** — 3001 by default. If something else on
   the host already uses it, see
   [Panel will not start / port in use](#panel-will-not-start--port-in-use)
   below before you're surprised by it.

5. **`DoLuaChecksum=false`** in the PZ server `.ini` — only if you want
   PanelBridge (teleport, heal, god mode, weather control, and the other
   RCON-can't-reach features). Skip this if you don't plan to use
   PanelBridge.

If you're installing through Docker and the panel will also read or write
PZ's own files (config editing, local backups, PanelBridge without SFTP),
also note the **numeric UID/GID that owns your PZ folders** (`id -u` /
`id -g` on the host) — you'll need it for `PUID`/`PGID` in `.env`. See
[Permission denied on mounted PZ folders](#permission-denied-on-mounted-pz-folders)
if you skip this and hit trouble.

---

## Part 2: Symptom-first troubleshooting

### Panel will not start / port in use

**What you see:** the panel process exits, or `docker logs` / the console
shows something like `Port 3001 is in use and PORT is explicitly set;
refusing to choose a different port.`

**What it means:** the panel tried to bind its HTTP port and something else
already had it. If you never set a `PORT` environment variable yourself, the
panel already tried a short retry-and-backoff sequence and then picked a
free port automatically — you'd see `Port 3001 remained unavailable after
... retries; selecting a free port automatically.` in the log, and the panel
is actually running, just not on 3001. Check the log for which port it
picked. If you **did** set `PORT` explicitly (an env var, `.env`, or a
Docker Compose mapping), the panel refuses to silently choose a different
one instead of binding somewhere you didn't expect — that's the case above.

**What to do:** find whatever is holding the port:
- Windows: `netstat -ano | findstr :3001`
- Linux/macOS: `ss -tlnp | grep :3001` (or `lsof -i :3001`)

Stop that process, or change `PORT` (bare-metal) / the left-hand side of the
port mapping in `docker-compose.yml` (Docker) to a free port, then restart.

The same message and the same fix apply to `HTTPS port ... is already in
use` if you've enabled `HTTPS=true`.

---

### Panel opens a new browser tab every time it starts or restarts

**What you see:** every time the panel (the Windows/macOS/Linux `.exe`
install, not Docker) starts up, it opens a new tab pointed at the panel's
login page — including on a restart, so if something is restarting the panel
repeatedly you end up with a pile of tabs to close by hand.

**What it means:** this is by design for a fresh, interactive install — the
first time you start the panel, it opens a tab automatically so you don't
have to know the URL and type it in yourself. It fires on *every* process
start, not just the first one, because the panel has no way to tell "first
run" apart from "restart #40" — it only knows it's starting. If the panel is
restarting more often than you expect, that's worth chasing down separately
(see below); the tab-per-start behavior itself is expected, not a bug, and
can be turned off.

**What to do:** set `PANEL_AUTO_OPEN_BROWSER=false` in a `.env` file in the
same folder as the panel `.exe` (create the file if it doesn't exist; it's
read automatically on every start), then restart the panel. Any of `0`,
`false`, `no`, or `off` works. This is the right setting for a headless box,
a server you control over RDP/SSH rather than sitting at, or any machine
where you'd rather keep one browser tab open yourself than have the panel
manage tabs for you.

**If the panel is restarting on its own and you don't know why:** the panel
itself has no built-in "restart periodically to free memory" feature —
nothing in its code restarts the panel process on a timer or a memory
threshold. If it's restarting anyway, something external is doing it: a
Task Scheduler entry, a service manager set to auto-restart on exit, an
update being applied (Settings > Updates restarts the panel to apply a
downloaded version), or a crash. Check `log.jsonl` in the panel's data
folder for `app-start` entries — repeated `app-start` events close together
in time, especially right after an error, point to a crash loop rather than
an intentional restart, and are worth reporting rather than just muting the
tab.

---

### Cannot log in / forgot the admin password

**What you see:** `Invalid username or password` even though you're sure
the password is right, or you simply never wrote it down.

**What it means, first:** if you've mistyped the password 10 times, the
account locks for 15 minutes — but the panel still shows the exact same
`Invalid username or password` message during the lockout, not a distinct
"account locked" message (this is deliberate: a message that changed when an
account got locked would let someone confirm an account exists just by
trying wrong passwords against it). If you were sure of the password and it
suddenly stops working for a while after several attempts, this is almost
certainly why. Wait 15 minutes and try again with the correct password
before assuming it's actually wrong.

After a few failed sign-in attempts from the same browser, the login page
itself starts showing a **"Still not working?"** hint explaining this same
15-minute lockout and pointing at recovery codes and `--reset-password` —
it appears the same way regardless of whether the account you're typing
exists, is locked, or the password was simply wrong, so seeing it isn't
itself a sign anything is broken.

Also check for `Too many login attempts. Please try again later.` — that's
a separate, shorter limit (5 attempts per minute per IP) and clears in under
a minute.

**If you actually don't know the password**, the panel has three recovery
paths, in order of convenience:

1. **A recovery code** — if you generated single-use recovery codes in
   advance (**Settings → Security**), use one on the login screen's "Recover
   account" flow. Each code works once.
2. **A local recovery token** — only works when you open the panel directly
   on the machine it's running on (loopback or one of the host's own IPs).
   The login screen's recovery flow creates `data/reset-token.txt` on the
   host; open that file, paste the token back into the browser. If the
   panel reports `No recovery token found yet. Create data/reset-token.txt
   on the panel host, then try again.`, the panel couldn't confirm the
   request came from the host itself — see the reverse-proxy case below.
3. **The `--reset-password` CLI flag** — run the panel binary/start script
   with `--reset-password` from a terminal on the host itself. This is
   interactive: it lists existing users and asks for a new password.

**If you're behind a reverse proxy** (nginx, Caddy, a VPS setup) and the
recovery screen says `This panel is running behind a reverse proxy, so it
can't verify a request came from the server itself. Create
data/reset-token.txt on the host directly, or use a recovery code instead.`
— the local-token flow can't confirm your browser request truly originated
on the host once a proxy sits in front of it. Either create
`data/reset-token.txt` yourself directly on the host — at least 8 characters
after trimming whitespace, under 1KB, and less than 24 hours old when you use
it, or the panel treats it the same as missing — or use a recovery code, or
run `--reset-password` on the host instead.

If you see `This recovery action is only available when the panel is opened
from the server itself.` instead (no proxy mentioned), you're just not
browsing from the host — open the panel's URL from the machine it's
actually running on, or use a recovery code / `--reset-password`.

---

### RCON: connection refused vs wrong password

**What you see:** the server won't connect over RCON, but the two possible
causes look similar from the outside.

**What to do:** either the dashboard's reconnect action or **Servers → Test
Connection** now tells the two failure modes apart the same way:

- `Unreachable` / `Could not connect to RCON. Is the server running and RCON
  enabled?` — the panel couldn't even open a TCP connection. This means the
  PZ server isn't listening there at all: it's not running, `RCONPort` in
  its `.ini` doesn't match what you typed, a firewall is blocking it, or the
  host/IP is wrong.
- `Authentication failed` / `Connected to the server, but authentication
  failed. Check the RCON password in server settings.` — the panel reached
  the server and got a response, but the password you gave doesn't match
  `RCONPassword` in the PZ server's `.ini`.

(The exact wording differs slightly between the two entry points, but both
now distinguish the same two causes — neither collapses them into one
generic message anymore.)

Once connected, if a live command later drops the connection, watch for
these in the console/log — they map to the same two root causes:
- `Cannot connect to server. Is the game server running with RCON enabled?`
  (the server stopped, or RCON dropped)
- `Connection was reset. Server may have restarted or crashed.`
- `Authentication failed. Check RCON password in server settings.` (the
  password changed on one side but not the other)

**If the server is managed somewhere the panel can't see it** (a remote
host, a container the panel doesn't control, or anywhere its own
process-detection can't find the PZ process): the panel normally checks
"is the server process running" before it even attempts an RCON connection,
and that check can itself be slow or simply unable to see a server it
doesn't manage locally. Set `RCON_SKIP_SERVER_CHECK=true` to skip that
pre-check and let the RCON connection attempt itself be the test — safe
because it only removes an early skip, not any authentication or network
check.

---

### Broadcast messages show garbled text for Chinese or other non-Latin characters

**What you see:** a Scheduled Task server message, or a manually sent
broadcast, shows up in-game as garbled or mismatched characters instead of
the Chinese (or other non-Latin) text you typed — not blank boxes, but
wrong-looking text.

**What it means:** the panel sends the message to the PZ server as correct
UTF-8 over RCON — this has been independently verified byte-for-byte,
including the packet's length field, for exactly this kind of text.
Garbled-but-present characters are the signature of a *charset mismatch* on
the receiving side, not a transmission problem: something decoded valid
UTF-8 bytes using the wrong text encoding. The most likely cause is Project
Zomboid's own dedicated server — a Java process — falling back to the host
OS's default text encoding instead of UTF-8 when it reads the RCON command.
On a Chinese-locale Windows machine, that default is typically GBK, not
UTF-8.

**What to do:**
- On the machine running the **PZ dedicated server** (not the panel, and
  not the game client) — if it's Windows: **Settings → Time & Language →
  Language & Region → Administrative language settings → Change system
  locale → check "Beta: Use Unicode UTF-8 for worldwide language support"**,
  then restart the machine and restart the PZ server. This forces Java's
  default text encoding to UTF-8 system-wide and is the most likely fix.
- If you launch the PZ server yourself rather than through the panel's
  generated startup script, you can instead add `-Dfile.encoding=UTF-8` to
  the `java` command line that starts `zombie.network.GameServer` — same
  effect, scoped to that one process instead of the whole machine.
- If neither helps, try sending the same text through a different broadcast
  method (for example PanelBridge's in-game chat action instead of RCON
  `servermsg`, where available) to see whether the problem is specific to
  RCON or affects every broadcast path — that narrows down whether this is
  an RCON-decode issue or something in PZ's text rendering more generally.

---

### Panel says it cannot determine whether the server is running

**What you see:** an error like `Can't verify whether the server is
actually stopped — the process-detection scan itself failed, not the
server. Check the panel's log for the error. If this keeps happening,
something on this host (antivirus, a full disk, or a missing system tool)
may be blocking detection.` — usually when trying to restore a backup or
apply a config template.

**What it means:** these are wholesale-overwrite operations (restoring a
backup, applying a template, wiping the world, deleting chunks) that refuse
to run unless the panel can *positively confirm* the server is stopped. If
the process-detection scan itself fails (times out, or a Windows/Linux
process-scan command errors), the panel treats that identically to "server
is running" and refuses — it never guesses "probably stopped" to let a
destructive action through.

**What to do:** check the panel's own log for the actual scan failure (it's
usually a timeout or a missing/failing OS process-listing tool). Common
causes: antivirus intercepting the process scan, a full disk, or — on
Linux — a minimal container image missing `ps`. Fix that underlying cause,
then retry; there is no override switch for this by design.

If you're applying a **template** to a server that **isn't** your currently
active/selected one, you'll instead see: `Can't verify this server's running
state — the panel can only check the currently active server. Switch to
this server first, then apply the template.` The panel can only
process-scan whichever server is currently active, so it refuses rather
than assume an unchecked server is safely stopped. Switch to that server in
the UI first, then apply the template.

If the server in question is configured as a **remote server via SFTP**,
its status will show as `Cannot verify without SFTP access` in the host
badge — this is expected; the panel has no local process to scan for a
remote host and never claims otherwise.

---

### Server process exited immediately after starting (code=1, signal=none) — startup failed

**What you see:** clicking Start fails almost instantly with `Server
process exited immediately after starting (code=1, signal=none) —
startup failed.` On Windows, `server-launch.log` for that server is
either **missing entirely, or exists but is empty (0 bytes)** — that
pairing (this exact error, plus no real log content) is the fingerprint
of this specific bug, not a different startup failure.

Occasionally you'll instead see the same error with a short extra line
attached, something like `'...\ProjectZomboid' is not recognized as an
internal or external command...`. That's still this bug — see below for
why the log is sometimes empty and sometimes has that one line in it
instead.

**Which versions this affects:** legacy **v1.2.15 and earlier** Windows
installs. The independent `v2.0.0` release line contains the fix.
v1.2.14 launched the server executable by its bare filename rather than
its full path, so the install path itself never appeared on the command
line handed to `cmd.exe` at all (that version had a different Windows
bug of its own, since fixed, where a hardened system setting could stop
that bare-filename launch from being found). v1.2.15 fixed that by
launching with the full, absolute path instead — which is correct, but
newly exposes that path (and the panel's own log path, below) to
`cmd.exe`'s quote handling on the command line, which is what this bug
is in.

**What it means:** if the game server's install path, or the **panel's
own** logs folder (wherever the panel itself is installed or configured
to keep its data — not a per-server setting), contains a **space**
anywhere, or one of the characters **`&` `(` `)` `^`**, `cmd.exe`'s quote
handling on that command line breaks before the actual game server
executable ever runs. `cmd.exe` exits with code 1 and nothing resembling
the server starts — this is a bug in how v1.2.15 builds that command
line, not anything wrong with your install, your path choice, or your
server configuration.

The log behaves differently depending on which character triggered it,
which is why both symptoms above are the same bug: a bare **space** or
**`&`**/**`^`** makes `cmd.exe`'s own output redirection fail before the
log file is ever opened, so it's missing or stays at 0 bytes. A **`(`**
in the path instead makes `cmd.exe` fail at looking up the command *after*
redirection was already set up successfully, so the log exists and
contains that one `is not recognized` line — but the game server still
never ran, exactly as if the log were empty.

**What to do (today, before the fix is released):** make sure both the
game server's install folder and the panel's own install/data location
are on a path with **no spaces and none of `&` `(` `)` `^`** — for
example `D:\PZServer` rather than `D:\Program Files\PZ Server (x86)`.
This is a workaround, not the intended fix; there is nothing else you
need to change, and nothing about your server's own configuration
(`.ini`, mods, RCON) is involved.

**When does a real fix arrive:** upgrade to `v2.0.0` or later. Don't take
"the code is fixed" to mean "my installed copy is fixed" — check the actual
panel version in Settings before assuming an upgrade covers this.

---

### Permission denied on mounted PZ folders

**What you see (Linux/Docker):** `Cannot read /some/path (EACCES). The
panel service account needs read and execute permission on this folder and
every parent folder.`

**What you see (Windows):** `Cannot read C:\some\path (EPERM). Run the
panel as an account that can read this folder.` (Windows permission errors
surface as `EPERM`, not `EACCES` — the code in parentheses is whatever the
OS actually returned, so treat the exact code as informational, not a
required match.)

**What it means:** the panel process's user doesn't have permission to
read a folder you pointed it at — almost always a PZ install or save
folder mounted into a Docker container with the wrong owner.

**What to do (Docker):** set `PUID` and `PGID` in `.env` to the numeric
Linux user/group that actually owns the PZ folders on the host (find them
with `id -u` and `id -g` on the host, run against the PZ folder's real
owner, not necessarily your own login), then `docker compose up -d` to
restart with the new values. `PUID`/`PGID` only apply when the container
starts as root, which is the default — if your runtime already pins a
non-root user (for example a Kubernetes pod with `runAsUser`), the
entrypoint skips its own ownership fix, and the mounted folder must already
be writable by that UID/GID instead.

**What to do (bare metal):** on Linux, confirm the account running the
panel (or the systemd service's configured user) has read+execute on the
target folder **and every parent folder** — a readable target folder behind
an unreadable parent still fails. On Windows, run the panel as (or grant
folder permissions to) an account that can read the path.

---

### PanelBridge shows disconnected

**What you see:** the PanelBridge status badge reads **"Bridge offline"**
(hint: *"Go to Settings → Bridge to configure"*) or **"Bridge waiting"**
(hint: *"Watching for PZ mod — start/restart the server"*).

**What it means:**
- **"Bridge waiting"** means the PZ server process is running, but the
  panel hasn't seen the mod check in yet. This is normal for the first
  minute or so after a (re)start while the mod initializes.
- **"Bridge offline"** means either the server isn't running, or
  PanelBridge isn't configured/installed at all.

**What to do:**
1. Confirm `PanelBridge.lua` is actually installed in the server's
   `Install/media/lua/server/` folder (the panel does this for you when you
   enable it from **Settings → PanelBridge**, unless you're on a remote
   server without shared filesystem access — see the Indifferent Broccoli /
   remote-SFTP guide for that path instead).
2. Confirm `DoLuaChecksum=false` is set in the PZ server `.ini` — if it's
   still `true`, PZ will refuse to load the modded file.
3. Fully restart the PZ server (not just save/reload) — the mod only loads
   on boot.
4. If it's been well over a minute since restart and it's still stuck on
   "Bridge waiting," check the PZ server's own console/log for a Lua error
   from PanelBridge, and check the panel's log for whether it's still
   watching for the mod's status file at all.
5. For a remote server without a shared filesystem, confirm **Settings →
   PanelBridge → Remote connection** has a working SFTP connection
   ("Verify and prepare SFTP" succeeds) and that **Start SFTP bridge** has
   actually been clicked — the badge stays offline until that bridge is
   running, even with valid credentials saved.

---

### Blank or partial World Map

**What you see:** the map area shows one of:
- **"No players on the map"** (subtitle: *"Player positions appear when
  PanelBridge is connected"*) — this isn't a map failure at all; it means
  no player position data is flowing, which needs PanelBridge connected
  (see the section above).
- **"Map tiles aren't loading"** (*"Panel can't reach tiles.pzmap.org. Check
  outbound HTTPS access and try Refresh."*) — the panel's own server
  couldn't reach the tile CDN at all. The map proxies and caches tiles
  server-side, so this is the panel host's outbound network, not your
  browser's.
- **"No map tiles at this zoom"** (*"tiles.pzmap.org is reachable but
  hasn't rendered this area at this detail level. Zoom out, or try Refresh
  later."*) — the CDN is reachable, but doesn't have tiles for exactly this
  area/zoom yet. Zooming out usually resolves this immediately.

**What to do:** for the two tile-related messages, check **Debug & Logs →
Diagnostics → World Map** for the same signal in more detail — a `B42 tile
CDN unreachable` finding there confirms it's the panel host's outbound
HTTPS access, not something wrong with your server. Also watch for a `B42
build auto-detect failed` warning: the panel normally detects the current
PZ map build automatically from `tiles.pzmap.org`, but if that discovery
fails, it silently falls back to a hardcoded older build, which will not
track the next PZ map release and can present as a wrong/stale map layout
rather than a missing one — the Diagnostics finding names which reason
discovery failed.

`curl` must be present on the panel host for build auto-detection to work
at all (Docker, Windows, and macOS packages already include it; a bare
Linux tarball install might not) — without it, the map still works, it just
never tracks a new PZ map release, and Diagnostics will flag it.

---

### Mod conflict scan stopped early / incomplete

**What you see:** a warning in the Mod Conflicts panel reading `File index
reached the global 300,000-entry limit — the conflict scan is incomplete.
Scan fewer mods at once or remove unused ones and retry.`

**What it means:** the scan indexes every file across every active mod to
detect overlaps, and stops rather than silently reporting a partial result
as if it were complete, once the combined file count crosses a fixed safety
ceiling (guarding against a crash on pathological, extremely large mod
lists).

**What to do:** disable mods you aren't actually using, or scan a smaller
subset at a time, then retry.
