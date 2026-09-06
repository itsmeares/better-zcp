import { describe, expect, it, vi } from "vitest";
import path from "path";

import {
  LinuxServiceLifecycle,
  buildLifecycleTemplate,
  getLinuxLifecycleCapabilities,
  getLifecycleServiceName,
  isManagedLifecycleProvider,
} from "../services/linuxServiceLifecycle.js";

const server = {
  id: "alpha-1",
  name: "Alpha Server",
  serverName: "servertest",
  installPath: "/opt/pz server",
};

describe("Linux managed-service lifecycle", () => {
  it("derives a stable service name from the immutable server id", () => {
    expect(getLifecycleServiceName(server)).toBe(
      "zomboid-panel-server-alpha-1",
    );
    expect(() => getLifecycleServiceName({ id: "../unsafe" })).toThrow(
      /invalid server id/i,
    );
  });

  it("recognizes only systemd and OpenRC as managed providers", () => {
    expect(isManagedLifecycleProvider("direct")).toBe(false);
    expect(isManagedLifecycleProvider("systemd")).toBe(true);
    expect(isManagedLifecycleProvider("openrc")).toBe(true);
    expect(isManagedLifecycleProvider("docker")).toBe(false);
  });

  it("advertises managed providers only for non-container Linux hosts", () => {
    expect(
      getLinuxLifecycleCapabilities({ platform: "linux", containerized: false }),
    ).toEqual({
      supported: true,
      platform: "linux",
      containerized: false,
      providers: ["direct", "systemd", "openrc"],
    });
    expect(
      getLinuxLifecycleCapabilities({ platform: "win32", containerized: false }),
    ).toMatchObject({ supported: false, providers: ["direct"] });
    expect(
      getLinuxLifecycleCapabilities({ platform: "linux", containerized: true }),
    ).toMatchObject({ supported: false, providers: ["direct"] });
  });

  it("renders a systemd unit with an ownership marker and safely quoted paths", () => {
    const template = buildLifecycleTemplate(server, "systemd", {
      serviceUser: "pzuser",
      homeDirectory: "/home/pzuser",
      fileExists: (candidate) => candidate.endsWith("start-server_servertest.sh"),
    });

    expect(template.filename).toBe("zomboid-panel-server-alpha-1.service");
    expect(template.content).toContain(
      "X-Zomboid-Panel-Server-ID: alpha-1",
    );
    expect(template.content).not.toContain('User=pzuser');
    expect(template.content).toContain('WorkingDirectory=/opt/pz server');
    expect(template.content).not.toMatch(/^WorkingDirectory="/m);
    expect(template.content).toContain(
      'ExecStart=/bin/bash "/opt/pz server/start-server_servertest.sh"',
    );
    expect(template.content).toContain("KillMode=control-group");
    expect(template.content).toContain("WantedBy=default.target");
    expect(template.installPath).toBe(
      "/home/pzuser/.config/systemd/user/zomboid-panel-server-alpha-1.service",
    );
  });

  it("renders an OpenRC service that is supervised outside the panel", () => {
    const template = buildLifecycleTemplate(server, "openrc", {
      serviceUser: "pzuser",
      homeDirectory: "/home/pzuser",
      fileExists: () => false,
    });

    expect(template.filename).toBe("zomboid-panel-server-alpha-1");
    expect(template.content).toContain("#!/sbin/openrc-run");
    expect(template.content).not.toContain("supervisor=supervise-daemon");
    expect(template.content).not.toMatch(/^command_args=/m);
    expect(template.content).not.toMatch(/^directory=/m);
    expect(template.content).toContain(
      'pidfile="${XDG_RUNTIME_DIR}/${RC_SVCNAME}.pid"',
    );
    expect(template.content).toContain(
      "X-Zomboid-Panel-Server-ID: alpha-1",
    );
    expect(template.content).toContain(
      "--chdir '/opt/pz server' \\",
    );
    expect(template.content).toContain(
      "-- /bin/bash '/opt/pz server/start-server.sh'",
    );
    expect(template.installPath).toBe(
      "/home/pzuser/.config/rc/init.d/zomboid-panel-server-alpha-1",
    );
  });

  it("systemd/OpenRC installPath and every embedded working-directory/launcher path are exactly what path.posix would produce, and provably NOT what path.win32 would produce for the same inputs", () => {
    const homeDirectory = "/home/pzuser";
    const installDir = server.installPath;
    const launcherName = `start-server_${server.serverName}.sh`;

    const posixJoin = path.posix.join(installDir, launcherName);
    const win32Join = path.win32.join(installDir, launcherName);
    expect(win32Join).not.toBe(posixJoin);
    expect(win32Join).toContain("\\");
    expect(posixJoin).not.toContain("\\");

    const systemdTemplate = buildLifecycleTemplate(server, "systemd", {
      serviceUser: "pzuser",
      homeDirectory,
      fileExists: (candidate) => candidate.endsWith(launcherName),
    });
    const expectedLauncherPath = path.posix.join(installDir, launcherName);
    const expectedSystemdInstallPath = path.posix.join(
      homeDirectory,
      ".config",
      "systemd",
      "user",
      `${getLifecycleServiceName(server)}.service`,
    );
    expect(systemdTemplate.installPath).toBe(expectedSystemdInstallPath);
    expect(systemdTemplate.content).toContain(
      `WorkingDirectory=${installDir}`,
    );
    expect(systemdTemplate.content).toContain(
      `ExecStart=/bin/bash "${expectedLauncherPath}"`,
    );
    expect(systemdTemplate.installPath).not.toContain("\\");
    expect(systemdTemplate.content).not.toMatch(/WorkingDirectory=.*\\/);
    expect(systemdTemplate.content).not.toMatch(/ExecStart=.*\\opt/);

    const openrcTemplate = buildLifecycleTemplate(server, "openrc", {
      serviceUser: "pzuser",
      homeDirectory,
      fileExists: () => false,
    });
    const expectedFallbackLauncherPath = path.posix.join(
      installDir,
      "start-server.sh",
    );
    const expectedOpenrcInstallPath = path.posix.join(
      homeDirectory,
      ".config",
      "rc",
      "init.d",
      getLifecycleServiceName(server),
    );
    expect(openrcTemplate.installPath).toBe(expectedOpenrcInstallPath);
    expect(openrcTemplate.content).toContain(
      `--chdir '${installDir}' \\`,
    );
    expect(openrcTemplate.content).toContain(
      `-- /bin/bash '${expectedFallbackLauncherPath}'`,
    );
    expect(openrcTemplate.installPath).not.toContain("\\");
    // No blanket "content has no backslash" check here, unlike the systemd
    // block above -- OpenRC's start()/stop() legitimately end several
    // lines with a real backslash (shell line-continuation, e.g.
    // "--chdir '...' \\"). The toContain() assertions above already pin
    // the exact correct --chdir/-- /bin/bash lines; a regex broad enough to
    // also catch a stray win32-joined path would match those legitimate
    // continuations too.
  });

  it("does not corrupt an OpenRC description containing a literal '$'", () => {
    const dollarServer = { ...server, name: "Alpha $CoolServer" };
    const template = buildLifecycleTemplate(dollarServer, "openrc", {
      fileExists: () => false,
    });
    expect(template.content).toContain(
      "name='Project Zomboid server Alpha $CoolServer'",
    );
    expect(template.content).not.toContain("\\$CoolServer");
  });

  it("routes systemd actions through execFile without a shell", async () => {
    const execFile = vi.fn(async (command, args) => {
      if (args.includes("show")) {
        return {
          code: 0,
          stdout:
            "LoadState=loaded\nActiveState=inactive\nEnvironment=ZOMBOID_PANEL_SERVER_ID=alpha-1\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const lifecycle = new LinuxServiceLifecycle(server, "systemd", {
      execFile,
      platform: "linux",
      containerized: false,
      waitForState: false,
    });

    const result = await lifecycle.run("start");

    expect(result.success).toBe(true);
    expect(execFile).toHaveBeenCalledWith("systemctl", [
      "--user",
      "start",
      "zomboid-panel-server-alpha-1.service",
    ]);
  });

  it("refuses to control a registered service owned by another profile", async () => {
    const lifecycle = new LinuxServiceLifecycle(server, "systemd", {
      platform: "linux",
      containerized: false,
      execFile: vi.fn(async () => ({
        code: 0,
        stdout:
          "LoadState=loaded\nActiveState=inactive\nEnvironment=ZOMBOID_PANEL_SERVER_ID=other\n",
        stderr: "",
      })),
    });

    const result = await lifecycle.preflightActivation();

    expect(result.ready).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.error).toMatch(/another server profile/i);
  });

  it("never enables managed host services inside a container", async () => {
    const lifecycle = new LinuxServiceLifecycle(server, "systemd", {
      platform: "linux",
      containerized: true,
      execFile: vi.fn(),
    });

    await expect(lifecycle.preflightActivation()).rejects.toThrow(
      /container installations/i,
    );
  });

  it("requires the installed service to be stopped before activation", async () => {
    const lifecycle = new LinuxServiceLifecycle(server, "systemd", {
      platform: "linux",
      containerized: false,
      execFile: vi.fn(async () => ({
        code: 0,
        stdout:
          "LoadState=loaded\nActiveState=active\nEnvironment=ZOMBOID_PANEL_SERVER_ID=alpha-1\n",
        stderr: "",
      })),
    });

    const result = await lifecycle.preflightActivation();

    expect(result.ready).toBe(false);
    expect(result.running).toBe(true);
    expect(result.error).toMatch(/already running/i);
  });

  describe("OpenRC status() scanFailed (2026-08-31 services sweep regression)", () => {
    function openrcLifecycle(execFile) {
      return new LinuxServiceLifecycle(server, "openrc", {
        platform: "linux",
        containerized: false,
        fileExists: () => true,
        readFile: () => `X-Zomboid-Panel-Server-ID: ${server.id}`,
        execFile,
      });
    }

    it("reports a confirmed-stopped service without scanFailed when rc-service genuinely answers non-zero", async () => {
      const status = await openrcLifecycle(
        vi.fn(async () => ({ code: 3, stdout: "stopped", stderr: "" })),
      ).status();

      expect(status.scanFailed).toBe(false);
      expect(status.running).toBe(false);
    });

    it("reports scanFailed, not a confident stopped state, when the rc-service exec itself fails", async () => {
      const status = await openrcLifecycle(
        vi.fn(async () => ({ code: 1, stdout: "", stderr: "", execFailed: true })),
      ).status();

      expect(status.scanFailed).toBe(true);
      expect(status.running).toBe(false);
    });

    it("reports scanFailed via the real execFile when rc-service cannot be found on this host", async () => {
      const status = await openrcLifecycle(undefined).status();

      expect(status.scanFailed).toBe(true);
      expect(status.running).toBe(false);
    });
  });
});
