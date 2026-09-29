# All-in-One Docker Deployment

The current stack runs the panel and Project Zomboid in one container. The
[Docker install guide](../../../docs/install/docker.md#path-a-all-in-one)
covers setup, updating, and the temporary game downtime during panel updates.

On an amd64 Linux Docker host with Docker Compose, `curl`, and `tar`:

```sh
curl -fsSL https://raw.githubusercontent.com/itsmeares/better-zcp/main/infra/docker/all-in-one/bootstrap.sh | sh
```

For a specific release, append `-s -- 2.0.0` after `sh`. The same command
updates an existing install after a full backup and a game stop. Keep any
custom `PANEL_HOME` or `BUILD_ROOT` setting when updating. The installer
retains the existing named volumes and removes the old updater service.

`docker-compose.yml` defines the panel and its four data volumes. The panel
reports releases but cannot apply Docker updates itself. No service in this
stack mounts the Docker socket.
