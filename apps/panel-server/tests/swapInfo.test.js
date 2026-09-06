import { afterEach, describe, expect, it, vi } from "vitest";

const mockExecFile = vi.fn();
const mockReadFile = vi.fn();

vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

vi.mock("fs", () => ({
  default: { promises: { readFile: (...args) => mockReadFile(...args) } },
}));

const {
  getSwapInfo,
  parseLinuxMeminfo,
  parseMacSwapusage,
  parseWindowsPageFileOutput,
} = await import("../utils/swapInfo.js");

// Node has no swap API at all (os.totalmem/freemem are RAM only), so this is
// genuinely platform-specific. The whole point of this feature (2026-08-26,
// Discord report from Tonin96: a 95%-red host-memory reading with no swap
// context to say whether that's fine or an emergency) is that a failed or
// unsupported lookup must never look like "zero swap" -- these tests pin
// all three states (real reading / genuinely none / could not determine)
// for each platform's parser, plus the process.platform dispatch itself.

const originalPlatform = process.platform;
function setPlatform(value) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}
afterEach(() => {
  setPlatform(originalPlatform);
  mockExecFile.mockReset();
  mockReadFile.mockReset();
});

describe("parseLinuxMeminfo", () => {
  it("reads a real SwapTotal/SwapFree pair into bytes", () => {
    const text = "MemTotal: 16384000 kB\nSwapTotal: 2097152 kB\nSwapFree: 1048576 kB\n";
    expect(parseLinuxMeminfo(text)).toEqual({ total: 2097152 * 1024, used: 1048576 * 1024 });
  });

  it("reports a real zero -- swap disabled on this Linux host is a genuine answer, not a failure", () => {
    const text = "SwapTotal: 0 kB\nSwapFree: 0 kB\n";
    expect(parseLinuxMeminfo(text)).toEqual({ total: 0, used: 0 });
  });

  it("returns null (could not determine) when the expected lines are missing", () => {
    expect(parseLinuxMeminfo("MemTotal: 16384000 kB\n")).toBeNull();
  });
});

describe("parseMacSwapusage", () => {
  it("reads a real total/used pair into bytes", () => {
    const text = "vm.swapusage: total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)";
    expect(parseMacSwapusage(text)).toEqual({ total: 2048 * 1024 * 1024, used: 512 * 1024 * 1024 });
  });

  it("reports a real zero when macOS has never needed to grow a swapfile", () => {
    const text = "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M";
    expect(parseMacSwapusage(text)).toEqual({ total: 0, used: 0 });
  });

  it("returns null (could not determine) on unparseable output", () => {
    expect(parseMacSwapusage("sysctl: unknown oid 'vm.swapusage'")).toBeNull();
  });
});

describe("parseWindowsPageFileOutput", () => {
  it("reads a single pagefile's allocated/current usage (MB) into bytes", () => {
    expect(parseWindowsPageFileOutput("4096 1024")).toEqual({
      total: 4096 * 1024 * 1024,
      used: 1024 * 1024 * 1024,
    });
  });

  it("sums multiple pagefiles", () => {
    expect(parseWindowsPageFileOutput("4096 1024\n2048 0\n")).toEqual({
      total: 6144 * 1024 * 1024,
      used: 1024 * 1024 * 1024,
    });
  });

  it('reports a real zero for the literal "NONE" -- no pagefile configured is a genuine answer', () => {
    expect(parseWindowsPageFileOutput("NONE")).toEqual({ total: 0, used: 0 });
  });

  it("returns null (could not determine) on empty output", () => {
    expect(parseWindowsPageFileOutput("")).toBeNull();
  });

  it("returns null (could not determine) on a malformed line rather than a partial sum", () => {
    expect(parseWindowsPageFileOutput("4096 1024\ngarbage\n")).toBeNull();
  });
});

describe("getSwapInfo() platform dispatch", () => {
  it("linux: reads /proc/meminfo and returns a real reading", async () => {
    setPlatform("linux");
    mockReadFile.mockResolvedValue("SwapTotal: 2097152 kB\nSwapFree: 1048576 kB\n");
    expect(await getSwapInfo()).toEqual({ total: 2097152 * 1024, used: 1048576 * 1024 });
  });

  it("linux: could not determine when /proc/meminfo is unreadable", async () => {
    setPlatform("linux");
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    expect(await getSwapInfo()).toBeNull();
  });

  it("darwin: shells out to sysctl and returns a real reading", async () => {
    setPlatform("darwin");
    mockExecFile.mockImplementation((file, args, opts, cb) =>
      cb(null, "vm.swapusage: total = 1024.00M  used = 256.00M  free = 768.00M", ""),
    );
    expect(await getSwapInfo()).toEqual({ total: 1024 * 1024 * 1024, used: 256 * 1024 * 1024 });
  });

  it("darwin: could not determine when sysctl fails", async () => {
    setPlatform("darwin");
    mockExecFile.mockImplementation((file, args, opts, cb) => cb(new Error("boom"), "", ""));
    expect(await getSwapInfo()).toBeNull();
  });

  it("win32: runs the fixed PowerShell command and returns a real reading", async () => {
    setPlatform("win32");
    mockExecFile.mockImplementation((file, args, opts, cb) => cb(null, "4096 1024", ""));
    expect(await getSwapInfo()).toEqual({ total: 4096 * 1024 * 1024, used: 1024 * 1024 * 1024 });

    // Arguments must stay fixed constants -- never anything request/user
    // derived -- since this runs on a raw system-command path.
    const [file, args] = mockExecFile.mock.calls[0];
    expect(file).toBe("powershell.exe");
    expect(args.every((a) => typeof a === "string")).toBe(true);
    expect(args).not.toContain(undefined);
  });

  it("win32: reports a real zero (no pagefile configured) rather than could-not-determine", async () => {
    setPlatform("win32");
    mockExecFile.mockImplementation((file, args, opts, cb) => cb(null, "NONE", ""));
    expect(await getSwapInfo()).toEqual({ total: 0, used: 0 });
  });

  it("win32: could not determine when the CIM query itself fails (non-zero exit)", async () => {
    setPlatform("win32");
    mockExecFile.mockImplementation((file, args, opts, cb) => cb(new Error("exit 1"), "", ""));
    expect(await getSwapInfo()).toBeNull();
  });

  it("an unsupported platform reports could-not-determine, never zero", async () => {
    setPlatform("sunos");
    expect(await getSwapInfo()).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});
