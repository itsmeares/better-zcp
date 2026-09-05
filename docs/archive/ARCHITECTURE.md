# Archived architecture notes

> Archived on 2026-09-05. This document describes the pre-rewrite
> architecture and is no longer authoritative. Keep current behavior aligned
> with the code, tests, and install guides while the rewrite is in progress.

# Architecture decisions

## Stack

The panel uses a Node.js and Express backend, a React, Vite, and TypeScript client, Socket.IO for real-time updates, and a lowdb JSON database. It ships as a Docker image and standalone Windows/Linux executable.

## Server profiles

Server profiles describe a local or remote Project Zomboid installation. Legacy `isRemote` records resolve to `native` or `remote-sftp`; the server-status model also recognizes `docker-local` and `docker-managed` values so persisted profiles remain accurately labeled. Docker lifecycle control is not integrated: provider labels do not grant Docker socket access or container management.

## PanelBridge

PanelBridge is a file-based bridge between the panel and the in-game Lua mod. The panel owns command files and reads response files; Lua only creates `.txt` files because Build 42 requires that extension. For local mounts, the panel can atomically install and verify the bundled PanelBridge Lua file when a server is activated.

## Mount discovery

`mountDiscovery.js` probes configured and common local PZ paths for install and save-data signatures. Discovery records are trusted only on the server: the client can request a mount scan, but server creation accepts only an exact server-side discovery. `PZ_SERVER_PATH` and `PZ_SAVE_PATH` provide fallback paths when persisted fields are empty.

## Templates

Templates are sparse JSON overrides for existing `server.ini` and SandboxVars settings. Secret, identity, and networking keys are excluded. Template mutations require an administrator and applying to the active server requires a verified stopped state. Server names are validated before paths are built; writes are serialized, backed up by default, and rolled back if the second file cannot be written. Unknown INI keys are skipped rather than appended.

## Status model

The active-server status endpoint reports three distinct signals: host/process or container state, RCON connectivity, and PanelBridge state. Healthy signals remain neutral in the client. Remote SFTP hosts are deliberately shown as unknown when the panel cannot verify their process state.

## Storage health

`diskMonitor.js` checks free space on the save volume every 60 seconds. Warning and critical thresholds are 90% and 95%. The system health endpoint combines disk state with the lowdb write circuit-breaker state; the client renders this only when a fault is present.

## File writes

Configuration and bridge installation writes use atomic temp-file replacement. `withFileLock()` serializes concurrent writes to the same path. Multi-file operations must either complete or restore earlier files from their original content.

## Authentication

Authentication uses bcrypt password hashing, JWT access tokens, refresh cookies, timing-safe comparisons, recovery codes, and role middleware. Privileged routes use `requireRole("admin")`; the client should hide mutation controls from authenticated non-admin users while the server remains the enforcement boundary.

## Deferred work

Docker capability discovery, managed-container metrics, and one-container lifecycle actions are disabled unless `PANEL_DOCKER_CONTROL_ENABLED=true` and the Docker socket is mounted. Even then, the panel recognizes only containers carrying `zomboid-panel.managed=true`; image names and provider labels never grant access. Lifecycle actions are administrator-only, strict-rate-limited, and re-check the label through Docker inspection immediately before acting. Resource snapshots are non-streaming and bounded to three concurrent Docker API calls. Do not infer that a Docker provider label or a detected mount permits lifecycle operations.
