import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLifecycleLock,
  isLifecycleLockedForServer,
} from "../services/lifecycleCoordinator.ts";

afterEach(() => {
  const cleanup = acquireLifecycleLock("test-cleanup");
  cleanup?.release();
});

describe("isLifecycleLockedForServer", () => {
  it("matches a resolved server by id or its existing display name", () => {
    const lock = acquireLifecycleLock("wipe", "server-1");
    expect(lock).not.toBeNull();

    expect(isLifecycleLockedForServer({ id: "server-1", name: "Ashenwood" })).toBe(true);
    expect(isLifecycleLockedForServer({ id: "server-2", name: "server-1" })).toBe(true);
    expect(isLifecycleLockedForServer({ id: "server-2", name: "Other" })).toBe(false);

    lock?.release();
  });

  it("does not turn an unconfigured install path into a global refusal", () => {
    const lock = acquireLifecycleLock("wipe", "server-1");
    expect(isLifecycleLockedForServer({ installPath: "/new/server" })).toBe(false);
    lock?.release();
  });
});
