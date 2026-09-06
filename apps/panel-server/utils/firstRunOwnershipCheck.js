import fs from "fs";
import { execSync } from "child_process";
import { getDataPaths } from "./paths.js";

function resolveAccountName(uid) {
  try {
    const name = execSync(`id -un ${uid}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name || null;
  } catch {
    return null;
  }
}

function resolveRunningGroup() {
  try {
    const name = execSync("id -gn", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name || String(process.getgid());
  } catch {
    return String(process.getgid());
  }
}

function describeAccount(uid) {
  const name = resolveAccountName(uid);
  return name ? `${name} (uid ${uid})` : `uid ${uid}`;
}

export function formatOwnershipDiagnostic({ paths, runningAs, owningAccounts, fixCommand }) {
  const list = paths.map((p) => `  - ${p}`).join("\n");
  return (
    `Refusing to start: the following path(s) exist but are not readable/writable ` +
    `by the account currently running the panel:\n${list}\n\n` +
    `Running as: ${runningAs}\n` +
    `Owned by:   ${owningAccounts}\n\n` +
    `This is almost always caused by starting the panel once with sudo, or as root, ` +
    `just to look at it -- that first run creates the data directory and everything ` +
    `in it (the database, its startup backup, the JWT signing key, the log files) ` +
    `all owned by root, and every one of them then becomes unreachable to the ` +
    `account that runs the panel afterward. Do not run the panel as root/sudo again, ` +
    `even just once to look at it -- see docs/install/linux.md.\n\n` +
    `Fix (run once, as root or with sudo):\n  ${fixCommand}\n\n` +
    `This does not loosen any file's permissions (0600/0700 stay exactly as they ` +
    `are) -- it only changes who owns them. Restart the panel as ${runningAs} again ` +
    `afterward.`
  );
}

export function checkAndExitIfOwnershipBlocked(candidatePaths) {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return false;
  }

  const offending = [];
  const ownerUidByPath = {};

  for (const p of candidatePaths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    const mask = stat.isDirectory()
      ? fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK
      : fs.constants.R_OK | fs.constants.W_OK;
    try {
      fs.accessSync(p, mask);
    } catch {
      offending.push(p);
      ownerUidByPath[p] = stat.uid;
    }
  }

  if (offending.length === 0) return false;

  const myUid = process.getuid();
  const runningAs = describeAccount(myUid);
  const owningAccounts = [...new Set(offending.map((p) => ownerUidByPath[p]))]
    .map(describeAccount)
    .join(", ");
  const runningUser = resolveAccountName(myUid) || String(myUid);
  const runningGroup = resolveRunningGroup();
  const fixCommand = `chown -R ${runningUser}:${runningGroup} ${offending.map((p) => `"${p}"`).join(" ")}`;

  const message = formatOwnershipDiagnostic({
    paths: offending,
    runningAs,
    owningAccounts,
    fixCommand,
  });
  console.error(`\n${message}\n`);
  process.exit(77);
  return true;
}

export function checkDataPathOwnership() {
  let dataDir, logsDir;
  try {
    ({ dataDir, logsDir } = getDataPaths());
  } catch {
    return;
  }
  checkAndExitIfOwnershipBlocked([dataDir, logsDir]);
}

checkDataPathOwnership();
