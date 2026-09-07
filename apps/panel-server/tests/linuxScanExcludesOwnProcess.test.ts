import { describe, expect, it, vi, afterEach, afterAll } from "vitest";


const execMock = vi.fn();
vi.mock("child_process", () => ({
  exec: (...args) => execMock(...args),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../utils/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", {
  value: "linux",
  configurable: true,
});

const { ServerManager } = await import("../services/serverManager.ts");

afterEach(() => {
  execMock.mockReset();
});

afterAll(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

function makeManager(overrides) {
  const manager = new ServerManager();
  Object.assign(manager, { configLoaded: true, ...overrides });
  return manager;
}

function mockPgrepOutput(line) {
  execMock.mockImplementation((cmd, _opts, callback) => {
    if (String(cmd).startsWith("pgrep")) {
      callback(null, line ? `${line}\n` : "");
    } else {
      callback(new Error("unexpected exec call in this test: " + cmd));
    }
  });
}

describe("getServerProcessDetails(): excludes the panel's own process from the scan", () => {
  it("a java-shaped pgrep line whose PID equals process.pid is excluded entirely -- not matched, not ambiguous", async () => {
    mockPgrepOutput(
      `${process.pid} java -jar /opt/zomboid-control-panel/server.jar`,
    );

    const manager = makeManager({
      serverName: "AnyServer",
      savePath: "/tmp/AnyServerZomboid",
      serverPath: "/opt/AnyServer",
    });
    const details = await manager.getServerProcessDetails();

    expect(details.running).toBe(false);
    expect(details.scanFailed).toBe(false);
  });

  it("positive control: a java-shaped ambiguous candidate with a DIFFERENT pid still triggers scanFailed:true -- proves the exclusion is PID-specific, not a blanket suppression", async () => {
    const otherPid = process.pid + 1;
    mockPgrepOutput(`${otherPid} java -jar /some/launcher/projectzomboid.jar`);

    const manager = makeManager({
      serverName: "AnyServer",
      savePath: "/tmp/AnyServerZomboid",
      serverPath: "/opt/AnyServer",
    });
    const details = await manager.getServerProcessDetails();

    expect(details.running).toBe(false);
    expect(details.scanFailed).toBe(true);
  });

  it("a non-java candidate (even with a DIFFERENT pid) is discarded as noise regardless of the pid exclusion -- proves the java requirement, not just the pid check, is doing the real work", async () => {
    const otherPid = process.pid + 2;
    mockPgrepOutput(`${otherPid} /usr/bin/bash /home/runner/work/zomboid-control-panel/zomboid-control-panel/worker.sh`);

    const manager = makeManager({
      serverName: "AnyServer",
      savePath: "/tmp/AnyServerZomboid",
      serverPath: "/opt/AnyServer",
    });
    const details = await manager.getServerProcessDetails();

    expect(details.running).toBe(false);
    expect(details.scanFailed).toBe(false);
  });
});
