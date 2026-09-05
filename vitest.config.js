import { defineConfig } from "vitest/config";

// Keep the root config deliberately small. The per-file setup isolates each test's data root,
// while the longer timeout covers real subprocess/timer tests when several suites run together.
// testTimeout: stock vitest defaults to 5000ms per test. This floor commonly runs several
// concurrent Claude agents plus normal dev tooling, and this suite includes tests that spawn
// real OS subprocesses (curl, powershell, cmd.exe) and probe real timers -- work whose wall-clock
// cost scales with CPU contention, not with a defect in the code under test. Confirmed by direct
// reproduction: pegging this machine's CPU at 100% (12 busy-loop processes on a 16-core box) made
// routeRoleSweep.test.js and db-tmp-cleanup.test.js fail with "Test timed out in 5000ms" on tests
// that pass comfortably (well under 1s) when the machine is idle; raising testTimeout to 60000ms
// and re-running under the identical load let both pass, with routeRoleSweep's slow case actually
// completing in 21479ms and db-tmp-cleanup's in 11946ms/10753ms. 60000ms is roughly 3x that worst
// observed run, matching the margin convention this codebase already uses elsewhere for the same
// class of problem (see server/tests/supervisor-restart.test.js's own per-test timeout comments).
// This is a slow-CI-affordance, not a defect mask: it does not touch any test that was failing for
// a reason other than contention, and per-test overrides in individual test files still take
// precedence where a narrower value is more appropriate.
//
// 2026-08-30, flake-class-fixed-margin-sync: if you re-run the busy-loop reproduction above to
// verify a similar contention theory, remember this floor routinely runs several agents at once --
// pegging every core starves all of them, not just your own terminal. One agent already had to kill
// 14 busy-loop processes mid-investigation after noticing this. Only run it when the floor is idle,
// and clean up the processes the moment you have your measurement.
export default defineConfig({
  test: {
    setupFiles: ["./server/tests/vitest.perFileDataDir.setup.mjs"],
    testTimeout: 60000,
  },
});
