import { describe, expect, it, beforeEach } from "vitest";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
  LIFECYCLE_IN_PROGRESS_CODE,
} from "../services/lifecycleCoordinator.js";

// 2026-09-04, lifecycle-lock investigation follow-up: the lock itself was
// never the bug (traced every acquire/release path -- all correct, process-
// wide scope is intentional). The actual defect was the refusal message:
// "Another server lifecycle operation is already in progress" names neither
// the operation nor the server holding the lock. Dwight, having just
// instrumented this exact code path, still read a correct 409 as a
// probable lock leak because the message gave him nothing to check it
// against. These tests lock in the fix: the message now names the holder
// when one was recorded, and degrades to the original generic wording
// (never "for 'undefined'") when it wasn't.
//
// `activeLock` is module-level state, so every test that acquires a lock
// must release it before the test ends (a leaked lock here would fail
// every subsequent test in this file AND in any other file importing this
// same module in the same worker) -- there is no vi.resetModules() escape
// hatch for a module-level singleton that other production code also holds
// live references into during a real run.

describe("lifecycleCoordinator: refusal message names the holder", () => {
  it("names both the operation and the server when acquired with a serverName", () => {
    const lock = acquireLifecycleLock("start", "DoomerZ");
    try {
      const response = lifecycleInProgressResponse();
      expect(response.error).toBe(
        "A 'start' operation for 'DoomerZ' is already in progress",
      );
      expect(response.code).toBe(LIFECYCLE_IN_PROGRESS_CODE);
    } finally {
      lock.release();
    }
  });

  it("names just the operation, without a stray 'for undefined', when no serverName was given", () => {
    const lock = acquireLifecycleLock("automatic-update");
    try {
      const response = lifecycleInProgressResponse();
      expect(response.error).toBe(
        "A 'automatic-update' operation is already in progress",
      );
      expect(response.error).not.toMatch(/undefined|null/i);
    } finally {
      lock.release();
    }
  });

  it("degrades to the original generic wording when nothing is currently held (defensive -- lifecycleInProgressResponse should only ever be called after a failed acquire, but must not crash or say 'undefined' if called otherwise)", () => {
    const response = lifecycleInProgressResponse();
    expect(response.error).toBe(
      "Another server lifecycle operation is already in progress",
    );
  });

  it("an empty or whitespace-only serverName degrades the same way a missing one does", () => {
    const lock = acquireLifecycleLock("restart", "   ");
    try {
      const response = lifecycleInProgressResponse();
      expect(response.error).toBe(
        "A 'restart' operation is already in progress",
      );
    } finally {
      lock.release();
    }
  });

  it("a second acquire attempt while the first is held still refuses (unchanged locking behavior) and the refusal names the FIRST holder, not the attempted second operation", () => {
    const first = acquireLifecycleLock("start", "ServerA");
    try {
      const second = acquireLifecycleLock("start", "ServerB");
      expect(second).toBeNull();
      const response = lifecycleInProgressResponse();
      expect(response.error).toBe(
        "A 'start' operation for 'ServerA' is already in progress",
      );
    } finally {
      first.release();
    }
  });

  it("after release, the message reverts to the generic wording (no stale holder leaking into a later refusal)", () => {
    const lock = acquireLifecycleLock("start", "DoomerZ");
    lock.release();
    // Nothing is held now -- a caller mis-invoking this without a fresh
    // failed acquire (defensive case, matches the earlier "nothing held"
    // test) must not still describe the just-released DoomerZ start.
    const response = lifecycleInProgressResponse();
    expect(response.error).not.toContain("DoomerZ");
    expect(response.error).toBe(
      "Another server lifecycle operation is already in progress",
    );
  });
});
