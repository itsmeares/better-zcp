import fs from "fs";
import path from "path";
import { execFile } from "child_process";

const FS_TIMEOUT_MS = 2000;

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: FS_TIMEOUT_MS, windowsHide: true, ...opts },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            stdout: stdout || "",
            stderr: stderr || "",
          });
        },
      );
    } catch {
      resolve({ ok: false, stdout: "", stderr: "" });
    }
  });
}

async function getDiskFreeFallback(targetPath) {
  try {
    const resolved = path.resolve(targetPath);
    if (process.platform === "win32") {
      const drive = resolved.slice(0, 2);
      if (!/^[A-Za-z]:$/.test(drive)) return null;
      const letter = drive[0].toUpperCase();
      const ps = await execFileP("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$d = Get-PSDrive -Name '${letter}' -ErrorAction SilentlyContinue; if ($d) { '{0} {1}' -f $d.Free, ($d.Free + $d.Used) }`,
      ]);
      if (ps.ok) {
        const parts = ps.stdout.trim().split(/\s+/);
        if (parts.length === 2) {
          const free = Number(parts[0]);
          const total = Number(parts[1]);
          if (Number.isFinite(free) && Number.isFinite(total) && total > 0) {
            return { free, total };
          }
        }
      }
      const wmic = await execFileP("wmic", [
        "logicaldisk",
        "where",
        `DeviceID='${letter}:'`,
        "get",
        "FreeSpace,Size",
        "/value",
      ]);
      if (wmic.ok) {
        const freeMatch = wmic.stdout.match(/FreeSpace=(\d+)/);
        const sizeMatch = wmic.stdout.match(/Size=(\d+)/);
        if (freeMatch && sizeMatch) {
          const free = Number(freeMatch[1]);
          const total = Number(sizeMatch[1]);
          if (Number.isFinite(free) && Number.isFinite(total) && total > 0) {
            return { free, total };
          }
        }
      }
      return null;
    }
    const df = await execFileP("df", ["-Pk", resolved]);
    if (!df.ok) return null;
    const lines = df.stdout.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const cols = lines[1].trim().split(/\s+/);
    if (cols.length < 4) return null;
    const totalKb = Number(cols[1]);
    const freeKb = Number(cols[3]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb)) return null;
    return { free: freeKb * 1024, total: totalKb * 1024 };
  } catch {
    return null;
  }
}

export async function getDiskFree(targetPath) {
  try {
    if (!targetPath) return null;
    if (typeof fs.promises.statfs === "function") {
      const stats = await withTimeout(
        fs.promises.statfs(targetPath),
        FS_TIMEOUT_MS,
        null,
      );
      if (stats) {
        return {
          free: stats.bavail * stats.bsize,
          total: stats.blocks * stats.bsize,
        };
      }
    }
    return await getDiskFreeFallback(targetPath);
  } catch {
    return null;
  }
}