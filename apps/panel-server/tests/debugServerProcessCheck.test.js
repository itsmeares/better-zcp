import { describe, expect, it } from "vitest";

// GET /diagnostics's server.process check. 2026-09-01 (Discord split-
// container report, user Deide): the check already skips with an honest
// note for remoteRconOnly (a remote-SFTP server has no local process to
// scan, treated as expected, not a fault) but had no equivalent for
// docker-local/docker-managed, where PZ runs as PID 1 of a *different*
// container and this page's local scan can never see it either (GH#114).
// Without the exemption, a split-container/docker-managed operator opening
// this page to troubleshoot got a red "Server process not running" --
// precisely the false lead sending them chasing their own config.
//
// resolveServerProcessCheckMode() is the pure decision behind that check
// (the actual diagOk/diagWarn/diagSkip calls stay literal/inline in the
// route so diagnosticsCheckRegistry.test.js's self-enforcing locale scanner
// can still find them).

const { resolveServerProcessCheckMode } = await import("../routes/debug.js");

describe("resolveServerProcessCheckMode", () => {
  it("is 'docker' (skip) for docker-local/docker-managed, same treatment as remoteRconOnly", () => {
    expect(
      resolveServerProcessCheckMode({
        remoteRconOnly: false,
        dockerManagedProvider: true,
        serverRunning: false,
      }),
    ).toBe("docker");
  });

  it("is 'docker' regardless of the (irrelevant for this topology) serverRunning value", () => {
    expect(
      resolveServerProcessCheckMode({
        remoteRconOnly: false,
        dockerManagedProvider: true,
        serverRunning: null,
      }),
    ).toBe("docker");
  });

  it("remoteRconOnly still wins over dockerManagedProvider if somehow both were true (existing exemption unchanged)", () => {
    expect(
      resolveServerProcessCheckMode({
        remoteRconOnly: true,
        dockerManagedProvider: true,
        serverRunning: false,
      }),
    ).toBe("remote");
  });

  it("is 'stopped' (warn) for a genuinely native server with no process running -- the exemption is scoped, not a blanket skip", () => {
    expect(
      resolveServerProcessCheckMode({
        remoteRconOnly: false,
        dockerManagedProvider: false,
        serverRunning: false,
      }),
    ).toBe("stopped");
  });

  it("is 'running' (ok) for a genuinely native server that IS running", () => {
    expect(
      resolveServerProcessCheckMode({
        remoteRconOnly: false,
        dockerManagedProvider: false,
        serverRunning: true,
      }),
    ).toBe("running");
  });

  it("is 'unknown' (skip) when the native scan itself failed", () => {
    expect(
      resolveServerProcessCheckMode({
        remoteRconOnly: false,
        dockerManagedProvider: false,
        serverRunning: null,
      }),
    ).toBe("unknown");
  });
});
