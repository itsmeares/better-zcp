import { describe, expect, it } from "vitest";


const { resolveServerProcessCheckMode } = await import("../routes/debug.ts");

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
