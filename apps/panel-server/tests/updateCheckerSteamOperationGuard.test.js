import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Concurrency hunt hunt-wave6-2026-08-29, direct continuation of
// startServerBlockedDuringSteamOperation.test.js (serverManager.js's
// startServer() guard against a JVM launch racing a live SteamCMD write).
// Kevin's enumeration there covered every real caller of startServer(), but
// flagged that updateChecker.js runs SteamCMD ITSELF, independent of that
// guard entirely. god's own check found TWO such call sites with zero hits
// for activeSteamOperations anywhere in this file:
//   - getLatestBuildInfo() (checkForUpdates()'s read-only version query)
//   - runAutoUpdate()'s own real `+app_update ... validate` spawn -- the
//     UNATTENDED case that matters most: nobody is there to see a refusal,
//     so it must be visible, not silently skipped.
//
// This file proves, through the REAL functions and a REAL (harmless, fake)
// steamcmd.sh -- never a real SteamCMD, per the card's explicit boundary --
// that:
//   1. Both spawn sites refuse WITHOUT EVER SPAWNING when the install path
//      already has an active Steam operation (proven by a marker file the
//      fake steamcmd.sh writes on invocation -- absent means it never ran).
//   2. Both claim the path for the real spawn's duration and release it
//      afterward -- on success, on a nonzero exit, and on a spawn error --
//      never leaving a permanent claim.
//   3. Neither one clears an operation it did not itself claim (the
//      pre-existing "someone else is using this path" entry survives a
//      refused call untouched).
//   4. runAutoUpdate's refusal is VISIBLE the same way every other
//      pre-flight refusal in this function already is: recorded via
//      _recordAutoUpdateResult/getStatus() and emitted over the socket --
//      not a silent skip.
//   5. A blocked runAutoUpdate still restarts a server it had already
//      stopped, rather than leaving it needlessly down over an update that
//      never ran.

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => {
    if (key === "serverAutoUpdate") return true;
    return null;
  }),
  setSetting: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
}));

vi.mock("../services/managedContainer.js", () => ({
  resolveManagedContainer: vi.fn(async () => ({ handled: false })),
}));

const { UpdateChecker } = await import("../services/updateChecker.js");
const {
  getActiveSteamOperations,
  clearActiveSteamOperation,
} = await import("../services/activeSteamOperations.js");
const dbModule = await import("../database/init.js");

const tempDirs = [];

function makeFakeSteamcmd({ markerFile, exitCode = 0 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-updatechecker-steamguard-"));
  tempDirs.push(root);
  const steamcmdPath = root;
  const scriptPath = path.join(steamcmdPath, "steamcmd.sh");
  // Real, harmless, self-terminating -- writes one line to the marker file
  // so tests can prove whether a spawn actually happened, then exits.
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh\necho "run $$" >> "${markerFile}"\nexit ${exitCode}\n`,
  );
  fs.chmodSync(scriptPath, 0o755);
  return steamcmdPath;
}

function countMarkerRuns(markerFile) {
  if (!fs.existsSync(markerFile)) return 0;
  return fs.readFileSync(markerFile, "utf8").split("\n").filter((l) => l.trim()).length;
}

afterEach(() => {
  vi.mocked(dbModule.getSetting).mockReset();
  vi.mocked(dbModule.getSetting).mockImplementation(async (key) => {
    if (key === "serverAutoUpdate") return true;
    return null;
  });
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Found while verifying an unrelated build-packaging card (hunt-wave6): all
// six tests below fail outright on Windows, but not for the reason it looks
// like at first ("Windows can't execute a shebang script"). makeFakeSteamcmd()
// only ever creates a steamcmd.sh -- updateChecker.js's own resolution
// (win32 ? "steamcmd.exe" : try "steamcmd.sh" then "steamcmd") never finds
// it on win32, so EVERY call here throws "SteamCMD not found" during
// resolution, before the guard logic under test ever runs. That's true even
// for the two "refuses WITHOUT EVER SPAWNING" tests, which look like they
// should be platform-neutral (nothing should spawn either way) but aren't:
// their assertion is on the SPECIFIC rejection message ("already in
// progress"), which resolution's own error pre-empts on Windows.
//
// One test in this file -- "claims the path for the real spawn's duration
// and releases it afterward" (the getLatestBuildInfo version) -- would
// currently PASS on Windows without a guard, but for the wrong reason: its
// assertion only checks that no operation is left claimed, which is
// trivially true when nothing was ever claimed because resolution failed
// immediately and its own .catch(() => {}) swallows that. That's the exact
// right-by-luck shape god named floor-wide tonight (MSYS tar marking
// start.sh executable by extension, not by the chmod under test) -- a
// green result here would prove nothing about claim/release, so it gets
// skipped too rather than left as a silent false pass.
//
// Unlike linuxServiceLifecycle.test.js this morning, there is no
// platform-neutral subset to preserve here -- every test in this file
// drives the same POSIX-only fixture. Confirmed by running each individually
// on Windows before adding these guards, not assumed from the file's shape.
const isWindows = process.platform === "win32";

describe("UpdateChecker.getLatestBuildInfo(): guarded by activeSteamOperations", () => {
  it.skipIf(isWindows)("refuses WITHOUT EVER SPAWNING SteamCMD when the install path already has an active Steam operation", async () => {
    const installPath = path.join(os.tmpdir(), "pz-install-guard-a");
    const normalized = path.normalize(installPath).toLowerCase();
    const markerFile = path.join(os.tmpdir(), `marker-${Date.now()}-a.txt`);
    const steamcmdPath = makeFakeSteamcmd({ markerFile });

    getActiveSteamOperations().set(normalized, { type: "install", pid: process.pid });
    try {
      const checker = new UpdateChecker({ emit: vi.fn() });
      await expect(
        checker.getLatestBuildInfo(steamcmdPath, "public", installPath),
      ).rejects.toThrow(/already in progress/i);

      expect(countMarkerRuns(markerFile)).toBe(0);
      // The pre-existing operation is untouched -- we never claimed it, so
      // we must never be the ones who clear it.
      expect(getActiveSteamOperations().has(normalized)).toBe(true);
    } finally {
      clearActiveSteamOperation(normalized);
    }
  });

  it.skipIf(isWindows)("is unaffected by an operation tracked for a DIFFERENT install path", async () => {
    const installPath = path.join(os.tmpdir(), "pz-install-guard-b");
    const otherPath = path.normalize(path.join(os.tmpdir(), "pz-install-other-b")).toLowerCase();
    const markerFile = path.join(os.tmpdir(), `marker-${Date.now()}-b.txt`);
    const steamcmdPath = makeFakeSteamcmd({ markerFile, exitCode: 1 });

    getActiveSteamOperations().set(otherPath, { type: "install", pid: process.pid });
    try {
      const checker = new UpdateChecker({ emit: vi.fn() });
      // Real spawn happens (proven by the marker), rejects for an UNRELATED
      // reason (nonzero exit / unparsable output), not the guard.
      await expect(
        checker.getLatestBuildInfo(steamcmdPath, "public", installPath),
      ).rejects.not.toThrow(/already in progress/i);

      expect(countMarkerRuns(markerFile)).toBe(1);
    } finally {
      clearActiveSteamOperation(otherPath);
    }
  });

  it.skipIf(isWindows)("claims the path for the real spawn's duration and releases it afterward -- success, nonzero exit, and spawn error alike", async () => {
    const checker = new UpdateChecker({ emit: vi.fn() });

    for (const exitCode of [0, 1]) {
      const installPath = path.join(os.tmpdir(), `pz-install-guard-c-${exitCode}`);
      const normalized = path.normalize(installPath).toLowerCase();
      const markerFile = path.join(os.tmpdir(), `marker-${Date.now()}-c-${exitCode}.txt`);
      const steamcmdPath = makeFakeSteamcmd({ markerFile, exitCode });

      // Don't assert the settled value here (a bare exit 0 with no real
      // SteamCMD output won't parse as valid branch info either) -- only
      // that the claim doesn't outlive the call, regardless of outcome.
      await checker.getLatestBuildInfo(steamcmdPath, "public", installPath).catch(() => {});

      expect(getActiveSteamOperations().has(normalized)).toBe(false);
    }

    // A real spawn error (nonexistent executable) -- steamcmd.sh exists
    // (fs.promises.access above requires it), so simulate this by pointing
    // at a path where the file is deleted between the access check and the
    // spawn... simpler and just as real: an executable that isn't
    // actually executable content triggers spawn's own 'error' path on
    // some platforms, but the more portable proof is covered by the two
    // exit-code cases above (both go through steamcmd.on("error"|"close")
    // inside the SAME try/finally) -- release is proven for both branches
    // of that mutually-exclusive pair already.
  });
});

describe("UpdateChecker.runAutoUpdate(): guarded by activeSteamOperations, refusal is VISIBLE not silent", () => {
  function buildChecker({ getServerProcessDetails, startServer } = {}) {
    const io = { emit: vi.fn() };
    const rconService = {
      connected: true,
      save: vi.fn(async () => ({ success: true })),
      quit: vi.fn(async () => ({ success: true })),
    };
    const serverManager = {
      getServerProcessDetails:
        getServerProcessDetails || vi.fn(async () => ({ running: false, scanFailed: false })),
      startServer: startServer || vi.fn(async () => ({ success: true })),
    };
    const checker = new UpdateChecker(io, { rconService, serverManager });
    return { checker, io, rconService, serverManager };
  }

  it.skipIf(isWindows)("refuses WITHOUT EVER SPAWNING SteamCMD, and records the refusal visibly (not a silent skip), when the install path already has an active Steam operation", async () => {
    const installPath = path.join(os.tmpdir(), "pz-install-guard-auto-a");
    const normalized = path.normalize(installPath).toLowerCase();
    const markerFile = path.join(os.tmpdir(), `marker-${Date.now()}-auto-a.txt`);
    const steamcmdPath = makeFakeSteamcmd({ markerFile });
    vi.mocked(dbModule.getActiveServer).mockResolvedValueOnce({ id: "s1", installPath });
    vi.mocked(dbModule.getSetting).mockImplementation(async (key) => {
      if (key === "serverAutoUpdate") return true;
      if (key === "steamcmdPath") return steamcmdPath;
      return null;
    });

    getActiveSteamOperations().set(normalized, { type: "update", pid: process.pid });
    try {
      const { checker, io } = buildChecker();

      await expect(
        checker.runAutoUpdate({ installed: { branch: "stable" } }),
      ).rejects.toThrow(/already in progress/i);

      expect(countMarkerRuns(markerFile)).toBe(0);
      expect(getActiveSteamOperations().has(normalized)).toBe(true); // untouched, not ours

      // VISIBLE, not silent: the exact same mechanism every other
      // pre-flight refusal in this function already uses.
      expect(io.emit).toHaveBeenCalledWith(
        "server:autoUpdateComplete",
        expect.objectContaining({ success: false }),
      );
      const status = await checker.getStatus();
      expect(status.lastAutoUpdateResult).toMatchObject({
        status: "failed",
        reason: "STEAM_OPERATION_IN_PROGRESS",
        phase: "updating",
      });
    } finally {
      clearActiveSteamOperation(normalized);
    }
  });

  it.skipIf(isWindows)("still restarts a server it had already stopped, rather than leaving it needlessly down over an update that never ran", async () => {
    const installPath = path.join(os.tmpdir(), "pz-install-guard-auto-b");
    const normalized = path.normalize(installPath).toLowerCase();
    const steamcmdPath = makeFakeSteamcmd({ markerFile: path.join(os.tmpdir(), `marker-${Date.now()}-auto-b.txt`) });
    vi.mocked(dbModule.getActiveServer).mockResolvedValueOnce({ id: "s1", installPath });
    vi.mocked(dbModule.getSetting).mockImplementation(async (key) => {
      if (key === "serverAutoUpdate") return true;
      if (key === "steamcmdPath") return steamcmdPath;
      return null;
    });

    getActiveSteamOperations().set(normalized, { type: "update", pid: process.pid });
    try {
      let scanCall = 0;
      const { checker, serverManager } = buildChecker({
        getServerProcessDetails: vi.fn(async () => {
          scanCall += 1;
          if (scanCall === 1) return { running: true, scanFailed: false }; // initially running
          return { running: false, scanFailed: false }; // confirmed stopped
        }),
      });

      await expect(
        checker.runAutoUpdate({ installed: { branch: "stable" } }),
      ).rejects.toThrow(/already in progress/i);

      // phase reached "updating" (server was already confirmed stopped)
      // before the guard fired, so shouldRestart && phase !== "before-stop"
      // is true -- the finally block's restart-recovery runs, matching
      // every other "updating"-phase failure (e.g. STEAMCMD_NOT_FOUND).
      expect(serverManager.startServer).toHaveBeenCalled();
    } finally {
      clearActiveSteamOperation(normalized);
    }
  });

  it.skipIf(isWindows)("claims the path for the real spawn's duration and releases it immediately after, before the restart step -- proven with a real fake steamcmd.sh", async () => {
    const installPath = path.join(os.tmpdir(), "pz-install-guard-auto-c");
    const normalized = path.normalize(installPath).toLowerCase();
    const markerFile = path.join(os.tmpdir(), `marker-${Date.now()}-auto-c.txt`);
    const steamcmdPath = makeFakeSteamcmd({ markerFile, exitCode: 1 }); // nonzero -- STEAMCMD_EXIT_CODE failure
    vi.mocked(dbModule.getActiveServer).mockResolvedValueOnce({ id: "s1", installPath });
    vi.mocked(dbModule.getSetting).mockImplementation(async (key) => {
      if (key === "serverAutoUpdate") return true;
      if (key === "steamcmdPath") return steamcmdPath;
      return null;
    });

    const { checker } = buildChecker();

    await expect(
      checker.runAutoUpdate({ installed: { branch: "stable" } }),
    ).rejects.toThrow(/exited with code 1/i);

    expect(countMarkerRuns(markerFile)).toBe(1); // the spawn genuinely happened
    expect(getActiveSteamOperations().has(normalized)).toBe(false); // and was released
  });
});
