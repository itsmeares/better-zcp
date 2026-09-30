import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let directory: string;
vi.mock("../utils/logger.ts", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("../database/init.ts", () => ({ getAdmin: async () => ({}), getServers: async () => [], getDatabaseFilePath: () => path.join(directory, "panel.sqlite") }));
vi.mock("../utils/paths.ts", () => ({ getDataPaths: () => ({ dataDir: directory }) }));
vi.mock("../utils/dockerDetect.ts", () => ({ isContainerized: () => false }));
import { PanelUpdateChecker } from "../services/panelUpdateChecker.ts";
afterEach(() => { vi.restoreAllMocks(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
async function preflight(diskError = false) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-preflight-"));
  fs.writeFileSync(path.join(directory, "panel.sqlite"), "temporary-fixture");
  const checker = new PanelUpdateChecker();
  vi.spyOn(checker, "getExeBasePath").mockReturnValue(path.join(directory, "ZomboidControlPanel"));
  vi.spyOn(checker, "isSupervisorAvailable").mockReturnValue(true);
  const pkg = Object.getOwnPropertyDescriptor(process, "pkg");
  Object.defineProperty(process, "pkg", { configurable: true, value: {} });
  checker.latestRelease = { version: "9.9.9", assets: [{ name: process.platform === "win32" ? "ZomboidControlPanel-windows.zip" : "ZomboidControlPanel-linux.tar.gz", size: 1024 }, { name: "checksums.txt", size: 1 }] } as never;
  if (diskError) vi.spyOn(fs, "statfsSync").mockImplementation(() => { throw new Error("not supported"); });
  try { return await checker.preflight(); } finally { if (pkg) Object.defineProperty(process, "pkg", pkg); else delete process.pkg; }
}
describe("native updater preflight", () => {
  it("keeps the warning if disk space cannot be determined", async () => { const result = await preflight(true); expect(result.ok).toBe(true); expect(result.warnings).toContainEqual(expect.stringMatching(/disk space could not be checked/i)); });
  it("does not warn when disk space is sufficient", async () => { const result = await preflight(); expect(result.ok).toBe(true); expect(result.warnings).toEqual([]); });
});
