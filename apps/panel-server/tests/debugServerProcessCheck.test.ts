import { describe, expect, it } from "vite-plus/test";


const { resolveServerProcessCheckMode } = await import("../routes/debug.ts");

describe("resolveServerProcessCheckMode", () => {
  it("is 'docker' (skip) for docker-local/docker-managed", () => {
    expect(
      resolveServerProcessCheckMode({
        dockerManagedProvider: true,
        serverRunning: false,
      }),
    ).toBe("docker");
  });

  it("is 'docker' regardless of the (irrelevant for this topology) serverRunning value", () => {
    expect(
      resolveServerProcessCheckMode({
        dockerManagedProvider: true,
        serverRunning: null,
      }),
    ).toBe("docker");
  });

  it("is 'stopped' (warn) for a genuinely native server with no process running -- the exemption is scoped, not a blanket skip", () => {
    expect(
      resolveServerProcessCheckMode({
        dockerManagedProvider: false,
        serverRunning: false,
      }),
    ).toBe("stopped");
  });

  it("is 'running' (ok) for a genuinely native server that IS running", () => {
    expect(
      resolveServerProcessCheckMode({
        dockerManagedProvider: false,
        serverRunning: true,
      }),
    ).toBe("running");
  });

  it("is 'unknown' (skip) when the native scan itself failed", () => {
    expect(
      resolveServerProcessCheckMode({
        dockerManagedProvider: false,
        serverRunning: null,
      }),
    ).toBe("unknown");
  });
});
