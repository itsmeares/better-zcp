import fs from "fs";
import { execFile } from "child_process";

// Node's `os` module has no swap API at all -- os.totalmem()/os.freemem()
// are physical RAM only. This is genuinely platform-specific: Linux exposes
// it as a cheap /proc/meminfo read, macOS needs `sysctl vm.swapusage`, and
// Windows has neither and needs a CIM/WMI query for pagefile usage (the
// closest Windows equivalent of swap).
//
// Every path below returns one of three things, never collapsing "unknown"
// into a number:
//   { total, used }  -- a real reading (total === 0 is a REAL reading too:
//                        it means swap is genuinely not configured, which is
//                        itself the answer a caller may need -- see the
//                        2026-08-26 Discord report this was built for).
//   null              -- could not determine (unreadable file, command
//                        failed, unsupported platform). Callers must render
//                        this as "unknown", never as zero.

const EXEC_TIMEOUT_MS = 3000;

function execFileP(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          resolve({ ok: !err, stdout: stdout || "" });
        },
      );
    } catch {
      resolve({ ok: false, stdout: "" });
    }
  });
}

// Parses /proc/meminfo's SwapTotal/SwapFree lines (always present on Linux,
// even when swap is disabled -- both read 0 kB in that case, which is a
// real reading, not a failure). Exported so this logic is directly
// unit-testable without faking a filesystem or process.platform.
export function parseLinuxMeminfo(text) {
  const totalMatch = /^SwapTotal:\s*(\d+)\s*kB/m.exec(text);
  const freeMatch = /^SwapFree:\s*(\d+)\s*kB/m.exec(text);
  if (!totalMatch || !freeMatch) return null;
  const total = Number(totalMatch[1]) * 1024;
  const free = Number(freeMatch[1]) * 1024;
  if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
  return { total, used: Math.max(0, total - free) };
}

// Parses `sysctl vm.swapusage`'s single-line output, e.g.:
// "vm.swapusage: total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)"
export function parseMacSwapusage(text) {
  const totalMatch = /total\s*=\s*([\d.]+)([KMGT])/i.exec(text);
  const usedMatch = /used\s*=\s*([\d.]+)([KMGT])/i.exec(text);
  if (!totalMatch || !usedMatch) return null;
  const unitBytes = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const total = Number(totalMatch[1]) * unitBytes[totalMatch[2].toUpperCase()];
  const used = Number(usedMatch[1]) * unitBytes[usedMatch[2].toUpperCase()];
  if (!Number.isFinite(total) || !Number.isFinite(used)) return null;
  return { total, used };
}

// Parses the fixed PowerShell command's own output (see readWindowsSwap
// below): one "<AllocatedBaseSize> <CurrentUsage>" line (both MB) per
// configured pagefile, or the literal "NONE" when Win32_PageFileUsage
// returned zero instances -- Windows genuinely has no pagefile configured,
// a real reading, not a failure. Sums across multiple pagefiles.
export function parseWindowsPageFileOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  if (trimmed === "NONE") return { total: 0, used: 0 };

  let total = 0;
  let used = 0;
  for (const line of trimmed.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) return null;
    const allocatedMB = Number(parts[0]);
    const usedMB = Number(parts[1]);
    if (!Number.isFinite(allocatedMB) || !Number.isFinite(usedMB)) return null;
    total += allocatedMB * 1024 * 1024;
    used += usedMB * 1024 * 1024;
  }
  return { total, used };
}

async function readLinuxSwap() {
  try {
    const text = await fs.promises.readFile("/proc/meminfo", "utf8");
    return parseLinuxMeminfo(text);
  } catch {
    return null;
  }
}

async function readMacSwap() {
  const result = await execFileP("sysctl", ["vm.swapusage"]);
  if (!result.ok) return null;
  return parseMacSwapusage(result.stdout);
}

// -ErrorAction Stop + a catch{exit 1} turns any CIM failure (provider
// unavailable, permissions) into a non-zero exit code, which execFile
// surfaces as `err` -- the only way to tell "the query failed" apart from
// "the query succeeded and found zero pagefiles" (emitted here as the
// literal string NONE), since both would otherwise print nothing.
// Arguments are fixed constants throughout -- nothing here is
// user-influenced.
const WINDOWS_SWAP_COMMAND =
  "try { $r = @(Get-CimInstance Win32_PageFileUsage -ErrorAction Stop); " +
  "if ($r.Count -eq 0) { 'NONE' } else { $r | ForEach-Object { \"$($_.AllocatedBaseSize) $($_.CurrentUsage)\" } } " +
  "} catch { exit 1 }";

async function readWindowsSwap() {
  const result = await execFileP("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_SWAP_COMMAND,
  ]);
  if (!result.ok) return null;
  return parseWindowsPageFileOutput(result.stdout);
}

// Host-wide swap, sourced honestly. Deliberately reports the HOST frame
// (same as os.totalmem()/os.freemem() elsewhere in this file's caller),
// not a container cgroup limit -- consistent with how hostMemTotal/
// hostMemUsed already behave when the panel itself runs containerised
// (Node's os module ignores cgroup memory limits the same way). A
// container-scoped swap number is a different question this does not
// answer; the client label says "Host swap" so the frame is explicit.
export async function getSwapInfo() {
  try {
    if (process.platform === "linux") return await readLinuxSwap();
    if (process.platform === "darwin") return await readMacSwap();
    if (process.platform === "win32") return await readWindowsSwap();
    return null;
  } catch {
    return null;
  }
}
