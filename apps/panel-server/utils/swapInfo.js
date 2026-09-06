import fs from "fs";
import { execFile } from "child_process";


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

export function parseLinuxMeminfo(text) {
  const totalMatch = /^SwapTotal:\s*(\d+)\s*kB/m.exec(text);
  const freeMatch = /^SwapFree:\s*(\d+)\s*kB/m.exec(text);
  if (!totalMatch || !freeMatch) return null;
  const total = Number(totalMatch[1]) * 1024;
  const free = Number(freeMatch[1]) * 1024;
  if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
  return { total, used: Math.max(0, total - free) };
}

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
