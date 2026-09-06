import { execFile as nodeExecFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { isContainerized } from "../utils/dockerDetect.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("LinuxServiceLifecycle");

export const LIFECYCLE_PROVIDERS = Object.freeze([
  "direct",
  "systemd",
  "openrc",
]);

type ManagedLifecycleProvider = "systemd" | "openrc";

interface LifecycleServer {
  id: string | number;
  name?: string | null;
  serverName?: string | null;
  serverPath?: string | null;
  installPath?: string | null;
  startCommand?: unknown;
}

interface LifecycleOptions {
  platform?: string;
  containerized?: boolean;
  serviceUser?: string;
  homeDirectory?: string;
  fileExists?: (filePath: string) => boolean;
  execFile?: ExecFile;
  readFile?: (filePath: string) => string;
  waitForState?: boolean;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  execFailed?: boolean;
}

type ExecFile = (command: string, args: string[]) => Promise<ExecResult>;

interface LifecycleInspection {
  registered: boolean;
  running: boolean;
  activeState: string;
  markerMatches: boolean;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isManagedLifecycleProvider(
  provider: string,
): provider is ManagedLifecycleProvider {
  return provider === "systemd" || provider === "openrc";
}

export function getLinuxLifecycleCapabilities(
  options: Pick<LifecycleOptions, "platform" | "containerized"> = {},
) {
  const platform = options.platform || process.platform;
  const containerized = options.containerized ?? isContainerized();
  return {
    supported: platform === "linux" && !containerized,
    platform,
    containerized,
    providers: platform === "linux" && !containerized
      ? [...LIFECYCLE_PROVIDERS]
      : ["direct"],
  };
}

export function getLifecycleServiceName(
  server: LifecycleServer | null | undefined,
): string {
  const id = String(server?.id ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Invalid server id for a managed lifecycle service");
  }
  return `zomboid-panel-server-${id.toLowerCase()}`;
}

function assertPlainValue(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text || /[\0\r\n]/.test(text)) {
    throw new Error(`${label} must be a non-empty single-line value`);
  }
  return text;
}

function quoteSystemdArg(value: string): string {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")}"`;
}

function plainSystemdValue(value: string): string {
  return String(value).replace(/%/g, "%%");
}

function quoteShellLiteral(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveLaunchTarget(
  server: LifecycleServer,
  fileExists: (filePath: string) => boolean = fs.existsSync,
) {
  if (server?.startCommand) {
    throw new Error(
      "Managed lifecycle services do not accept a custom start command. Configure a .sh launcher path instead.",
    );
  }

  const configuredPath = assertPlainValue(
    server?.serverPath || server?.installPath,
    "Server install path",
  );
  if (/\.sh$/i.test(configuredPath)) {
    return {
      workingDirectory: path.posix.dirname(configuredPath),
      launcherPath: configuredPath,
    };
  }
  if (/\.(bat|cmd|exe)$/i.test(configuredPath)) {
    throw new Error("Managed Linux services require a .sh launcher");
  }

  const serverName = assertPlainValue(server?.serverName, "Server name");
  const generated = path.posix.join(
    configuredPath,
    `start-server_${serverName}.sh`,
  );
  return {
    workingDirectory: configuredPath,
    launcherPath: fileExists(generated)
      ? generated
      : path.posix.join(configuredPath, "start-server.sh"),
  };
}

export function buildLifecycleTemplate(
  server: LifecycleServer,
  provider: string,
  options: LifecycleOptions = {},
) {
  if (!isManagedLifecycleProvider(provider)) {
    throw new Error(`Unsupported managed lifecycle provider: ${provider}`);
  }
  const serviceName = getLifecycleServiceName(server);
  const serverId = String(server.id);
  const serviceUser = assertPlainValue(
    options.serviceUser || os.userInfo().username,
    "Service user",
  );
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(serviceUser)) {
    throw new Error("Service user contains unsupported characters");
  }
  const launch = resolveLaunchTarget(server, options.fileExists);
  const description = `Project Zomboid server ${String(
    server.name || server.serverName,
  ).replace(/[\r\n]/g, " ")}`;

  if (provider === "systemd") {
    const content = [
      `# X-Zomboid-Panel-Server-ID: ${serverId}`,
      "[Unit]",
      `Description=${plainSystemdValue(description)}`,
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `WorkingDirectory=${plainSystemdValue(launch.workingDirectory)}`,
      `Environment=${quoteSystemdArg(`ZOMBOID_PANEL_SERVER_ID=${serverId}`)}`,
      `ExecStart=/bin/bash ${quoteSystemdArg(launch.launcherPath)}`,
      "Restart=on-failure",
      "RestartSec=5",
      "TimeoutStopSec=180",
      "KillMode=control-group",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    return {
      provider,
      serviceName,
      filename: `${serviceName}.service`,
      installPath: path.posix.join(
        options.homeDirectory || os.homedir(),
        ".config",
        "systemd",
        "user",
        `${serviceName}.service`,
      ),
      content,
      commands: [
        `sudo loginctl enable-linger ${serviceUser}`,
        "install -d -m 0755 ~/.config/systemd/user",
        `install -m 0644 <downloaded-file> ~/.config/systemd/user/${serviceName}.service`,
        "systemctl --user daemon-reload",
        `systemctl --user enable ${serviceName}.service`,
      ],
    };
  }

  const content = [
    "#!/sbin/openrc-run",
    `# X-Zomboid-Panel-Server-ID: ${serverId}`,
    `name=${quoteShellLiteral(description)}`,
    `description=${quoteShellLiteral(description)}`,
    'pidfile="$' + '{XDG_RUNTIME_DIR}/$' + '{RC_SVCNAME}.pid"',
    "",
    "depend() {",
    "  need net",
    "  after firewall",
    "}",
    "",
    // No supervisor=/command=/command_args=/directory= here on purpose --
    // see quoteShellLiteral()'s comment. start()/stop() call supervise-daemon
    // directly so the launcher path and working directory are ordinary argv
    // entries in a single-pass bash context, not values openrc-run.sh
    // re-evaluates a second time.
    "start() {",
    '  ebegin "Starting $' + '{name}"',
    '  supervise-daemon "$' + '{RC_SVCNAME}" \\',
    "    --start \\",
    '    --pidfile "$' + '{pidfile}" \\',
    "    --respawn-delay 5 \\",
    "    --respawn-max 0 \\",
    `    --chdir ${quoteShellLiteral(launch.workingDirectory)} \\`,
    `    --env ${quoteShellLiteral(`ZOMBOID_PANEL_SERVER_ID=${serverId}`)} \\`,
    `    -- /bin/bash ${quoteShellLiteral(launch.launcherPath)}`,
    "  eend $?",
    "}",
    "",
    "stop() {",
    '  ebegin "Stopping $' + '{name}"',
    '  supervise-daemon "$' + '{RC_SVCNAME}" --stop --pidfile "$' + '{pidfile}"',
    "  eend $?",
    "}",
    "",
  ].join("\n");
  return {
    provider,
    serviceName,
    filename: serviceName,
    installPath: path.posix.join(
      options.homeDirectory || os.homedir(),
      ".config",
      "rc",
      "init.d",
      serviceName,
    ),
    content,
    commands: [
      "install -d -m 0755 ~/.config/rc/init.d",
      `install -m 0755 <downloaded-file> ~/.config/rc/init.d/${serviceName}`,
      `rc-update --user add ${serviceName} default`,
    ],
  };
}

function defaultExecFile(command: string, args: string[]): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const env = { ...process.env };
    if (!env.XDG_RUNTIME_DIR && Number.isInteger(uid)) {
      env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
    }
    nodeExecFile(command, args, { timeout: 15000, env }, (error, stdout, stderr) => {
      const errorCode = typeof error?.code === "number" ? error.code : null;
      const execFailed = Boolean(error) && errorCode === null;
      resolve({
        code: errorCode ?? (error ? 1 : 0),
        stdout: String(stdout || ""),
        stderr: String(stderr || errorMessage(error) || ""),
        execFailed,
      });
    });
  });
}

function parseSystemdShow(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

export class LinuxServiceLifecycle {
  private readonly server: LifecycleServer;
  private readonly provider: ManagedLifecycleProvider;
  private readonly serviceName: string;
  private readonly execFile: ExecFile;
  private readonly fileExists: (filePath: string) => boolean;
  private readonly readFile: (filePath: string) => string;
  private readonly platform: string;
  private readonly containerized: boolean;
  private readonly waitForState: boolean;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    server: LifecycleServer,
    provider: string,
    options: LifecycleOptions = {},
  ) {
    if (!isManagedLifecycleProvider(provider)) {
      throw new Error(`Unsupported managed lifecycle provider: ${provider}`);
    }
    this.server = server;
    this.provider = provider;
    this.serviceName = getLifecycleServiceName(server);
    this.execFile = options.execFile || defaultExecFile;
    this.fileExists = options.fileExists || fs.existsSync;
    this.readFile = options.readFile || ((file) => fs.readFileSync(file, "utf8"));
    this.platform = options.platform || process.platform;
    this.containerized = options.containerized ?? isContainerized();
    this.waitForState = options.waitForState !== false;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  assertSupported(): void {
    if (this.platform !== "linux") {
      throw new Error(`${this.provider} lifecycle is supported only on Linux`);
    }
    if (this.containerized) {
      throw new Error(
        "Container installations must keep the direct lifecycle provider and their existing image-based process model",
      );
    }
  }

  async inspect(): Promise<LifecycleInspection> {
    this.assertSupported();
    const marker = `ZOMBOID_PANEL_SERVER_ID=${this.server.id}`;
    if (this.provider === "systemd") {
      const unit = `${this.serviceName}.service`;
      const result = await this.execFile("systemctl", [
        "--user",
        "show",
        unit,
        "--property=LoadState",
        "--property=ActiveState",
        "--property=Environment",
      ]);
      const values = parseSystemdShow(result.stdout);
      const registered = values.LoadState && values.LoadState !== "not-found";
      const running = ["active", "activating", "reloading"].includes(
        values.ActiveState,
      );
      return {
        registered: Boolean(registered),
        running,
        activeState: values.ActiveState || "unknown",
        markerMatches: Boolean(
          registered && String(values.Environment || "").includes(marker),
        ),
        error:
          !registered && result.stderr
            ? result.stderr.trim().slice(0, 300)
            : null,
      };
    }

    const initPath = path.posix.join(
      process.env.XDG_CONFIG_HOME || path.posix.join(os.homedir(), ".config"),
      "rc",
      "init.d",
      this.serviceName,
    );
    const registered = this.fileExists(initPath);
    let markerMatches = false;
    if (registered) {
      try {
        markerMatches = this.readFile(initPath).includes(
          `X-Zomboid-Panel-Server-ID: ${this.server.id}`,
        );
      } catch (error) {
        return {
          registered: true,
          running: false,
          activeState: "unknown",
          markerMatches: false,
          error: `Could not read ${initPath}: ${errorMessage(error)}`,
        };
      }
    }
    const status = registered
      ? await this.execFile("rc-service", ["--user", this.serviceName, "status"])
      : { code: 3, stdout: "", stderr: "" };
    const execFailed = Boolean(status.execFailed);
    return {
      registered,
      running: registered && !execFailed && status.code === 0,
      activeState: !registered
        ? "not-found"
        : execFailed
          ? "unknown"
          : status.code === 0
            ? "active"
            : "inactive",
      markerMatches,
      error: execFailed || (status.code !== 0 && status.code !== 3)
        ? status.stderr.trim().slice(0, 300)
        : null,
    };
  }

  async preflightActivation() {
    const status = await this.inspect();
    if (!status.registered) {
      return {
        ready: false,
        ...status,
        error: status.error
          ? `${this.serviceName} is not registered or its status could not be checked: ${status.error}`
          : `Install ${this.serviceName} before activating this provider`,
      };
    }
    if (!status.markerMatches) {
      return {
        ready: false,
        conflict: true,
        ...status,
        error:
          "The registered service belongs to another server profile or lacks the panel ownership marker",
      };
    }
    if (status.running) {
      return {
        ready: false,
        ...status,
        error:
          "The managed service is already running. Stop it before activation; the panel will not silently adopt it.",
      };
    }
    return { ready: true, conflict: false, ...status };
  }

  async status() {
    const status = await this.inspect();
    if (!status.registered) {
      return {
        running: false,
        scanFailed: true,
        error: status.error
          ? `Managed service ${this.serviceName} is not installed or its status could not be checked: ${status.error}`
          : `Managed service ${this.serviceName} is not installed`,
      };
    }
    if (!status.markerMatches) {
      return {
        running: false,
        scanFailed: true,
        error: `Managed service ${this.serviceName} failed ownership validation`,
      };
    }
    return {
      running: status.running,
      scanFailed: status.activeState === "unknown",
      activeState: status.activeState,
      error: status.error,
    };
  }

  async run(action: string) {
    if (!["start", "stop", "restart"].includes(action)) {
      throw new Error(`Unsupported lifecycle action: ${action}`);
    }
    const current = await this.inspect();
    if (!current.registered || !current.markerMatches) {
      return {
        success: false,
        confirmed: false,
        error: !current.registered
          ? `Managed service ${this.serviceName} is not installed`
          : `Managed service ${this.serviceName} failed ownership validation`,
      };
    }
    if (action === "start" && current.running) {
      return { success: true, confirmed: true, message: "Server is already running" };
    }
    if (action === "stop" && !current.running) {
      return { success: true, confirmed: true, message: "Server is already stopped" };
    }

    const args = this.provider === "systemd"
      ? ["--user", action, `${this.serviceName}.service`]
      : ["--user", this.serviceName, action];
    const command = this.provider === "systemd" ? "systemctl" : "rc-service";
    const result = await this.execFile(command, args);
    if (result.code !== 0) {
      return {
        success: false,
        confirmed: false,
        error: (result.stderr || result.stdout || `${command} exited ${result.code}`)
          .trim()
          .slice(0, 500),
      };
    }

    if (this.waitForState) {
      const expectedRunning = action !== "stop";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await this.status();
        if (!status.scanFailed && status.running === expectedRunning) {
          return {
            success: true,
            confirmed: true,
            message: `Server ${action} completed through ${this.provider}`,
          };
        }
        await this.sleep(250);
      }
      return {
        success: false,
        confirmed: false,
        error: `${this.provider} accepted ${action}, but the resulting service state could not be confirmed`,
      };
    }

    log.info(`${this.provider} ${action} accepted for ${this.serviceName}`);
    return {
      success: true,
      confirmed: true,
      message: `Server ${action} accepted by ${this.provider}`,
    };
  }
}

export function createLinuxServiceLifecycle(
  server: LifecycleServer,
  provider: string,
  options?: LifecycleOptions,
) {
  return new LinuxServiceLifecycle(server, provider, options);
}
