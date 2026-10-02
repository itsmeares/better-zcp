import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "fs";
import os from "os";
import path from "path";


vi.mock("../database/init.ts", () => ({
  getTrackedMods: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  getCurrentServer: vi.fn(async () => null),
}));

vi.mock("../utils/paths.ts", () => ({
  getDataPaths: vi.fn(() => ({
    dataDir: "/tmp/mods-conflict-scan-event-loop-test",
    logsDir: "/tmp/mods-conflict-scan-event-loop-test",
  })),
}));

const { default: router, buildFileIndex } = await import("../routes/mods.ts");
const { getCurrentServer } = await import("../database/init.ts");

const WORKSHOP_ID = "123456789";

function buildSingleModFixture(serverPath, wsId, fileCount) {
  const modDir = path.join(
    serverPath,
    "steamapps",
    "workshop",
    "content",
    "108600",
    wsId,
    "onlymod",
  );
  const subdirs = ["lua/server", "textures", "sound"];
  const mediaPath = path.join(modDir, "media");
  for (const d of subdirs) fs.mkdirSync(path.join(mediaPath, d), { recursive: true });
  let written = 0;
  let i = 0;
  while (written < fileCount) {
    const d = subdirs[i % subdirs.length];
    fs.closeSync(fs.openSync(path.join(mediaPath, d, `f${written}.dat`), "w"));
    written++;
    i++;
  }
}

describe("buildFileIndex() yields to the event loop many times while indexing one large mod", () => {
  let serverPath;

  beforeEach(() => {
    serverPath = fs.mkdtempSync(path.join(os.tmpdir(), "mods-conflict-scan-el-"));
  });

  afterEach(() => {
    fs.rmSync(serverPath, { recursive: true, force: true });
    vi.mocked(getCurrentServer).mockResolvedValue(null);
    vi.restoreAllMocks();
  });

  it("reports the scanned INI snapshot before completing an empty Workshop scan", async () => {
    fs.writeFileSync(path.join(serverPath, "Fixture.ini"), "WorkshopItems=\nMods=OnlyA;OnlyB\n");
    vi.mocked(getCurrentServer).mockResolvedValue({
      installPath: serverPath,
      serverConfigPath: serverPath,
      serverName: "Fixture",
    });
    const chunks = [];
    const route = router.stack.find(layer => layer.route?.path === "/conflicts/stream");
    await route.route.stack[0].handle({ on: vi.fn() }, {
      writable: true,
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      write: chunk => chunks.push(chunk),
      end: vi.fn(),
    });
    const events = chunks.join("").split("\n\n").filter(Boolean);
    expect(events[0]).toContain("event: init");
    expect(JSON.parse(events[0].split("data: ")[1])).toEqual({
      totalWorkshopIds: 0,
      workshopIds: [],
      modLoadOrder: ["OnlyA", "OnlyB"],
    });
    expect(events[1]).toContain("event: complete");
  });

  it("yield count scales with file count instead of staying fixed at one-per-mod", async () => {
    buildSingleModFixture(serverPath, WORKSHOP_ID, 500);
    const smallSpy = vi.spyOn(global, "setImmediate");
    await buildFileIndex([WORKSHOP_ID], serverPath, null, null);
    const smallYields = smallSpy.mock.calls.length;
    smallSpy.mockRestore();
    fs.rmSync(path.join(serverPath, "steamapps"), { recursive: true, force: true });

    buildSingleModFixture(serverPath, WORKSHOP_ID, 6000);
    const largeSpy = vi.spyOn(global, "setImmediate");
    const { fileIndex, modsScanned } = await buildFileIndex(
      [WORKSHOP_ID],
      serverPath,
      null,
      null,
    );
    const largeYields = largeSpy.mock.calls.length;
    largeSpy.mockRestore();

    expect(modsScanned).toBe(1);
    expect(Object.keys(fileIndex).length).toBe(6000);

    expect(smallYields).toBe(1);
    expect(largeYields).toBeGreaterThan(smallYields * 2);
  });

  it("yields repeatedly during a large single-mod walk", async () => {
    buildSingleModFixture(serverPath, WORKSHOP_ID, 8000);

    const yieldSpy = vi.spyOn(global, "setImmediate");
    try {
      await buildFileIndex([WORKSHOP_ID], serverPath, null, null);

      expect(yieldSpy.mock.calls.length).toBeGreaterThan(3);
    } finally {
      yieldSpy.mockRestore();
    }
  });
});
