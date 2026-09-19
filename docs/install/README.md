# Install Guides

One guide per setup. Each stands alone — pick yours and start there, you
don't need to read the others first.

- **[windows.md](windows.md)** — Running the panel directly on a Windows PC
  or Windows server: extract and run, no Docker. Covers RCON setup, opening
  Windows Firewall, what to do if port 3001 is taken, and keeping the panel
  running at boot via Task Scheduler.
- **[linux.md](linux.md)** — Running the panel directly on Linux (a VPS, a
  home server): extract and run, no Docker. Covers the glibc floor, running
  as a non-root user, installing the bundled systemd service (including the
  `ReadWritePaths` trap), SteamCMD's 32-bit library requirements, and
  opening the firewall with ufw or firewalld.
- **[managed-game-services.md](managed-game-services.md)** — Optional
  per-server systemd or OpenRC isolation so panel restarts and updates do not
  own the game-server process.
- **[docker.md](docker.md)** — Docker or Unraid: a single all-in-one
  container, a panel bound to an existing PZ install, or Unraid specifically.
- **[troubleshooting.md](troubleshooting.md)** — Something didn't work.
  Organized by what's actually on your screen, not by which guide you
  followed or which subsystem you suspect — start here regardless of which
  path above you took.
  Not covered here: macOS (Docker Desktop or OrbStack) is short enough to
  live in the main [README](../../README.md#macos) instead of getting its
  own file.

For anything past initial install — PanelBridge, updates, remote access, the
full feature list — see the main [README.md](../../README.md).
