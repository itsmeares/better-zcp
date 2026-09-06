import fs from "fs";
import { execSync } from "child_process";
import { getDataPaths } from "./paths.js";

type OwnershipDiagnostic = {
  paths: string[];
  runningAs: string;
  owningAccounts: string;
  fixCommand: string;
};

function resolveAccountName(uid: number): string | null {
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

function resolveRunningGroup(): string {
  const fallback =
    typeof process.getgid === "function" ? String(process.getgid()) : "unknown";
  try {
    const name = execSync("id -gn", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name || fallback;
  } catch {
    return fallback;
  }
}

function describeAccount(uid: number): string {
  const name = resolveAccountName(uid);
  return name ? `${name} (uid ${uid})` : `uid ${uid}`;
}

export function formatOwnershipDiagnostic({
  paths,
  runningAs,
  owningAccounts,
  fixCommand,
}: OwnershipDiagnostic): string {
  const list = paths.map((entry) => `  - ${entry}`).join("\n");
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

export function checkAndExitIfOwnershipBlocked(candidatePaths: string[]): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return false;
  }

  const offending: string[] = [];
  const ownerUidByPath: Record<string, number> = {};

  for (const entry of candidatePaths) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entry);
    } catch {
      continue;
    }
    const mask = stat.isDirectory()
      ? fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK
      : fs.constants.R_OK | fs.constants.W_OK;
    try {
      fs.accessSync(entry, mask);
    } catch {
      offending.push(entry);
      ownerUidByPath[entry] = stat.uid;
    }
  }

  if (offending.length === 0) return false;

  const myUid = process.getuid();
  const runningAs = describeAccount(myUid);
  const owningAccounts = [...new Set(offending.map((entry) => ownerUidByPath[entry]))]
    .map(describeAccount)
    .join(", ");
  const runningUser = resolveAccountName(myUid) || String(myUid);
  const runningGroup = resolveRunningGroup();
  const fixCommand = `chown -R ${runningUser}:${runningGroup} ${offending
    .map((entry) => `"${entry}"`)
    .join(" ")}`;

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

export function checkDataPathOwnership(): void {
  let dataDir: string;
  let logsDir: string;
  try {
    ({ dataDir, logsDir } = getDataPaths());
  } catch {
    return;
  }
  checkAndExitIfOwnershipBlocked([dataDir, logsDir]);
}

checkDataPathOwnership();
