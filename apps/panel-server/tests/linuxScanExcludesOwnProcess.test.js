import { describe, expect, it, vi, afterEach, afterAll } from "vitest";

// LINUX BUG HUNT follow-up (2026-08-29): the load-bearing fix against the
// CI-runner regression is looksLikeUndeterminedJvmCandidate (requiring a
// "java" signal, not just "mentions zomboid") -- see
// linuxScanAmbiguousProcessDetection.test.js for that, exercised with real
// spawns. This file covers the SECONDARY, belt-and-braces layer: an
// explicit process.pid exclusion, in case a real panel process's own
// command line ever coincidentally contained "java" as a substring (not
// expected for a `node` process, but cheap to guard explicitly rather than
// rely solely on that never happening).
//
// Can't reliably trigger a real self-match in CI (the checkout path won't
// happen to contain both "zomboid" and "java"), so this mocks child_process
// exec to inject a synthetic pgrep line whose PID is THIS test's own
// process.pid and whose command line is deliberately java-shaped -- the
// exact shape that would otherwise be misclassified as ambiguous evidence
// without the pid exclusion.

const execMock = vi.fn();
vi.mock("child_process", () => ({
  exec: (...args) => execMock(...args),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../utils/logger.js", () => ({
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

const { ServerManager } = await import("../services/serverManager.js");

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

// exec() is called positionally as exec(cmd, options, callback) throughout
// serverManager.js's Linux scan path.
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

    // The panel's own process is excluded, so the scan sees nothing at all
    // -- a genuinely idle result, not "unknown".
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
