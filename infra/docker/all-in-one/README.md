# Managed Docker Stack

The stack runs the panel and each Project Zomboid server in separate
containers. The [Docker install guide](../../../docs/install/docker.md#path-a-managed-stack)
covers setup, updating, and migration from the combined container.

On an amd64 Linux Docker host with Docker Compose, `curl`, and `tar`:

```sh
curl -fsSL https://raw.githubusercontent.com/itsmeares/better-zcp/main/infra/docker/all-in-one/bootstrap.sh | sh
```

For a specific release, append `-s -- 2.0.0` after `sh`. The same command
updates an existing install after a full backup. Stop the game once when
migrating from the old combined container. Keep any
custom `PANEL_HOME` or `BUILD_ROOT` setting when updating. The installer
retains the existing named volumes and removes the old updater service.

`docker-compose.yml` defines the panel and its four data volumes. Game
containers are created from server profiles when started. The panel reports
releases but cannot apply Docker updates itself. Its Docker socket mount grants
host-level Docker control; use this stack only when you trust its administrator.
