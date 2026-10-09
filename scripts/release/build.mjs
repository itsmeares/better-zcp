import esbuild from "esbuild";
import archiver from "archiver";
import { execFileSync, execSync } from "child_process";
import fs from "fs";
import { createRequire } from "module";
import path from "path";
import crypto from "crypto";
import { gzipSync } from "zlib";
import { pathToFileURL } from "url";

const distDir = "./dist-exe";
const releaseDir = "./release";
const linuxArchiveStagingPath = "./ZomboidControlPanel-linux.tar.gz";
const linuxArchivePath = "./release/ZomboidControlPanel-linux.tar.gz";
const pkgCliPath = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@yao-pkg/pkg")),
  "bin.js",
);

const LINUX_ARCHIVE_EXECUTABLE_NAMES = new Set([
  "ZomboidControlPanel",
  "start.sh",
  "install-linux-service.sh",
]);

function createLinuxReleaseArchive(sourceDir, archivePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver("tar", { gzip: true });

    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);

    archive.directory(sourceDir, false, (entry) => {
      if (entry.stats.isDirectory()) {
        entry.mode = 0o755;
      } else {
        entry.mode = LINUX_ARCHIVE_EXECUTABLE_NAMES.has(path.basename(entry.name))
          ? 0o755
          : 0o644;
      }
      return entry;
    });

    archive.finalize();
  });
}
const DEFAULT_API_CONTRACT_VERSION = 1;

export function resolveBuildSha(env = process.env) {
  const configured = String(env.GITHUB_SHA || env.PANEL_BUILD_SHA || "").trim();
  if (configured) return configured;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveApiContractVersion(env = process.env) {
  const parsed = Number(env.PANEL_API_CONTRACT_VERSION);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_API_CONTRACT_VERSION;
}

export function validateArgusBundle(luaSource, modInfo) {
  const runtimeVersions = [
    ...luaSource.matchAll(/^[ \t]*local[ \t]+Argus[ \t]*=[ \t]*\{[ \t]*VERSION[ \t]*=[ \t]*"([^"]+)"/gm),
  ];
  const modVersions = [...modInfo.matchAll(/^modversion=([^\r\n]+)$/gm)];
  if (runtimeVersions.length !== 1 || modVersions.length !== 1) {
    throw new Error("Game integration must contain exactly one runtime and mod.info version");
  }
  if (runtimeVersions[0][1] !== modVersions[0][1]) {
    throw new Error("Game integration runtime and mod.info versions differ");
  }
  return runtimeVersions[0][1];
}

export function createEmbeddedClientBundle(clientDist, expectedMetadata) {
  const files = {};
  const walk = (directory, relativeDirectory = "") => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path
        .join(relativeDirectory, entry.name)
        .split(path.sep)
        .join("/");
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files[relativePath] = fs.readFileSync(absolutePath).toString("base64");
      } else {
        throw new Error(`Unsupported client build entry: ${relativePath}`);
      }
    }
  };

  walk(clientDist);
  if (!files["index.html"] || !files["build-info.json"]) {
    throw new Error("Client build is missing index.html or build-info.json");
  }

  let clientMetadata;
  try {
    clientMetadata = JSON.parse(
      Buffer.from(files["build-info.json"], "base64").toString("utf8"),
    );
  } catch (error) {
    throw new Error(`Client build metadata is invalid: ${error.message}`, {
      cause: error,
    });
  }
  if (
    clientMetadata.panelVersion !== expectedMetadata.panelVersion ||
    clientMetadata.buildSha !== expectedMetadata.buildSha ||
    Number(clientMetadata.apiContractVersion) !==
      expectedMetadata.apiContractVersion
  ) {
    throw new Error("Client build metadata does not match the executable build");
  }

  return gzipSync(
    Buffer.from(JSON.stringify({ schemaVersion: 1, files }), "utf8"),
  ).toString("base64");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanDir(dir, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 1000,
        });
      }
      return true;
    } catch (error) {
      if (i === maxRetries - 1) {
        console.warn(`Could not fully clean ${dir}: ${error.message}`);
        console.warn("Attempting to continue anyway...");
        return false;
      }
      console.log(`Retry ${i + 1}/${maxRetries} for ${dir}...`);
      await delay(2000);
    }
  }
  return false;
}

function resolveTargets(args) {
  const wantsAll = args.includes("--all");
  const wantsWindows = args.includes("--windows");
  const wantsLinux = args.includes("--linux");

  if (wantsAll || (wantsWindows && wantsLinux)) {
    return ["win", "linux"];
  }

  if (wantsWindows) {
    return ["win"];
  }

  if (wantsLinux) {
    return ["linux"];
  }

  return [process.platform === "win32" ? "win" : "linux"];
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function getClientDistFileHashes(clientDist) {
  const hashes = {};
  const walk = (directory, relativeDirectory = "") => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path
        .join(relativeDirectory, entry.name)
        .split(path.sep)
        .join("/");
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hashes[relativePath] = sha256File(absolutePath);
      } else {
        throw new Error(`Unsupported client build entry: ${relativePath}`);
      }
    }
  };
  walk(clientDist);
  return hashes;
}

function resolveBuiltBinaryPath(target) {
  const candidates =
    target === "linux"
      ? [
          "./dist-exe/zomboid-control-panel",
          "./dist-exe/zomboid-control-panel-linux",
        ]
      : [
          "./dist-exe/zomboid-control-panel.exe",
          "./dist-exe/zomboid-control-panel-win.exe",
        ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export function writeReleaseReadme() {
  const readme = `# Zomboid Control Panel

## First 10 Minutes

### Windows
1. Run Start.bat (double-click it — or double-click ZomboidControlPanel.exe directly).
2. Open your browser to http://localhost:3001
3. Create the admin account (first screen you'll see).
4. Open Servers and add your PZ server. You'll need the RCON port and
   password from the server's .ini (RCONPort=... / RCONPassword=...) and
   its install folder path — the panel can't discover these on its own.

### Linux (Ubuntu / Debian / CentOS Stream / Rocky)
1. In a terminal, in this folder: chmod +x start.sh ZomboidControlPanel
   (execute permissions usually survive tar xzf already — this is a safety net)
2. Run: ./start.sh
3. Open your browser to http://localhost:3001
4. Create the admin account.
5. Open Servers and add your PZ server (same RCON port/password/install-path
   info as the Windows step above).

That's it for a first run. Running this as a background service, behind a
firewall, or as a dedicated non-root user is covered in the fuller guide
named below — none of it is required just to see the panel working once.

## If It Doesn't Start

Three things stop most first launches:

- "Port 3001 is in use", or the panel silently starts on a different port —
  something else on this machine already has 3001. Check the console/log
  for which port it actually picked, or free up 3001 and restart.
- Linux "Permission denied" — the execute bit didn't survive extraction.
  Run: chmod +x ZomboidControlPanel start.sh
- Linux: nothing happens, or a glibc error — this binary needs glibc 2.28+
  (Ubuntu 20.04+, Debian 10+, CentOS Stream 8+, Rocky 8+). CentOS 7 (glibc
  2.17) is not supported — use Docker instead.

More symptoms and fixes, organized by what's actually on your screen: see
docs/install/troubleshooting.md — it's in this same folder, no internet
needed. (Path below.)

## Where To Go Next

This file only covers the first ten minutes. The fuller guides are right
here in this folder, so they work with no internet — and also live on
GitHub if you'd rather read them there or check for updates to them:

  docs/install/                                    (this folder, offline)
  https://github.com/itsmeares/better-zcp  (same guides, online)

- docs/install/windows.md         Windows: running at startup / as a service, firewall.
- docs/install/linux.md           Linux: the bundled systemd service, a non-root
                                   user, SteamCMD's 32-bit library requirements,
                                   firewall (ufw/firewalld), reverse proxies.
- docs/install/docker.md          Docker and Unraid — three setups depending on
                                   where Project Zomboid itself runs. Not needed
                                   for this package; only relevant if you'd
                                   rather switch to Docker instead.
- docs/install/troubleshooting.md Symptom-first fixes, organized by what's on
                                   your screen, not by subsystem.

For everything else — game integration, updates, remote access, the full feature
list — see README.md in the GitHub repository (not shipped in this archive,
needs internet).

## Folder Structure
- ZomboidControlPanel.exe - Windows standalone binary
- ZomboidControlPanel      - Linux standalone binary
- Start.bat                - Windows launch script
- start.sh                 - Linux launch script
- zomboid-panel.service    - systemd unit file (Linux) — see docs/install/linux.md, in this folder
- install-linux-service.sh - explicit systemd installer; run with --enable to start the service
- docker-compose.yml       - Docker Compose, managed stack (panel plus game containers)
- docker-compose.panel-only.yml - Docker Compose, panel for an existing Project Zomboid server
- docs/install/            - Install guides for every platform (see Where To Go Next, above)
- client/dist/             - Web interface copy for manual upgrades and legacy installs
- data/panel.sqlite        - Panel database (created on first run)
- data/README.txt          - Upgrade-safety notes for the data/ folder
- logs/                    - Application logs
- pz-mod/                  - Game integration server-side Lua
- checksums.txt            - SHA256 hashes for release archives
- release-manifest.json    - Build metadata for this package

The standalone binary embeds the matching web interface and can recover from
an older or missing client/dist folder. Keep client/dist when using the
journaled updater or a manual archive upgrade; it is still retained in the
package for compatibility with older binaries.

## Game Integration Setup (Optional)
The panel installs the server-side game integration before starting or
restarting a configured server. If permissions prevent installation, open
Settings → Game integration and use Install after correcting the server path.

## Upgrading
- The panel auto-update feature handles upgrades safely — prefer it.
- Stop the panel before extracting a manual upgrade. Keep data/ untouched.
- This rebuilt panel starts with data/panel.sqlite. Older db.json and db.sqlite
  files are left intact, without importing their panel settings. Create the
  admin account and register existing game servers again. Game saves, player
  databases and server configs stay in their existing locations.
- SQLite snapshots are stored in data/backups/panel-*.sqlite. The newest five
  are kept. Recovery uses a verified backup and preserves the damaged file.

`;

  fs.writeFileSync("./release/README.txt", readme);
}

export function generateStartBat() {
  return ['@echo off', 'cd /d "%~dp0"', '"%~dp0ZomboidControlPanel.exe" %*', ''].join("\r\n");
}

export function generateStartSh() {
  return `#!/bin/sh
set -eu
cd "$(dirname "$0")"
RUNNER=".panel-runner-$$"
(umask 077; set -C; cat ./ZomboidControlPanel > "$RUNNER")
chmod 700 "$RUNNER"
exec "./$RUNNER" --panel-supervisor "$@"
`;
}

async function main() {
  const args = process.argv.slice(2);
  const targets = resolveTargets(args);
  const rootPkg = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
  const panelVersion = rootPkg.version || "0.0.0";
  const buildSha = resolveBuildSha({
    GITHUB_SHA: process.env.GITHUB_SHA,
    PANEL_BUILD_SHA: process.env.PANEL_BUILD_SHA,
  });
  const apiContractVersion = resolveApiContractVersion();

  const luaSourcePath = "./integrations/argus/Argus/media/lua/server/Argus.lua";
  const modInfoPath = "./integrations/argus/Argus/mod.info";
  if (!fs.existsSync(luaSourcePath) || !fs.existsSync(modInfoPath)) {
    throw new Error(`Game integration source is required for release builds (${luaSourcePath}, ${modInfoPath})`);
  }
  const luaSource = fs.readFileSync(luaSourcePath, "utf8");
  const modInfo = fs.readFileSync(modInfoPath, "utf8");
  const argusVersion = validateArgusBundle(luaSource, modInfo);
  const argusLuaB64 = Buffer.from(luaSource).toString("base64");

  await cleanDir(distDir);
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  await cleanDir(releaseDir);
  if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(releaseDir, { recursive: true });
  }

  console.log("Building client...");
  try {
    execSync("pnpm run build", {
      cwd: "./apps/panel-client",
      stdio: "inherit",
      env: {
        ...process.env,
        PANEL_BUILD_SHA: buildSha,
        PANEL_API_CONTRACT_VERSION: String(apiContractVersion),
      },
    });
    console.log("Client built successfully");
    execFileSync(process.execPath, ["scripts/check-client-boundary.mjs"], {
      stdio: "inherit",
    });
  } catch (error) {
    console.error("Client build failed:", error.message);
    process.exit(1);
  }

  const clientDistPath = "./apps/panel-client/dist";
  const embeddedClientDistB64 = createEmbeddedClientBundle(clientDistPath, {
    panelVersion,
    buildSha,
    apiContractVersion,
  });
  const clientDistFileHashes = getClientDistFileHashes(clientDistPath);
  console.log(
    `Embedded client bundle prepared (${embeddedClientDistB64.length} base64 chars)`,
  );

  console.log("Building server bundle...");

  console.log(
    `Version: ${panelVersion} (build ${buildSha}, API contract ${apiContractVersion})`,
  );

  console.log(
    `Embedding game integration v${argusVersion} (${argusLuaB64.length} base64 chars)`,
  );

  await esbuild.build({
    entryPoints: ["./apps/panel-server/native.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "./dist-exe/server.cjs",
    external: ["@aws-sdk/client-s3", "*.node"],
    define: {
      "import.meta.url": "import_meta_url",
      PANEL_VERSION: JSON.stringify(panelVersion),
      PANEL_BUILD_SHA: JSON.stringify(buildSha),
      PANEL_API_CONTRACT_VERSION: JSON.stringify(apiContractVersion),
      ARGUS_LUA_B64: JSON.stringify(argusLuaB64),
      PANEL_CLIENT_DIST_B64: JSON.stringify(embeddedClientDistB64),
    },
    banner: {
      js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
    },
  });

  console.log("Server bundled successfully");

  const pkgConfig = {
    name: "zomboid-control-panel",
    version: panelVersion,
    main: "server.cjs",
    bin: "server.cjs",
    pkg: {
      scripts: "server.cjs",
      targets: targets.map((target) => `node22-${target}-x64`),
      outputPath: path.resolve(distDir),
    },
  };

  fs.writeFileSync(
    "./dist-exe/package.json",
    JSON.stringify(pkgConfig, null, 2),
  );

  console.log(`Creating executables for: ${targets.join(", ")}`);
  try {
    execFileSync(
      process.execPath,
      [
        pkgCliPath,
        "--config",
        "package.json",
        "--compress",
        "GZip",
        "--public",
        "--public-packages",
        "*",
        "server.cjs",
      ],
      {
        cwd: distDir,
        stdio: "inherit",
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.startsWith("npm_package_"),
          ),
        ),
      },
    );
  } catch (error) {
    console.error("Failed to create executable(s):", error.message);
    process.exit(1);
  }

  const builtArtifacts = [];
  for (const target of targets) {
    const sourceBinary = resolveBuiltBinaryPath(target);
    const targetBinary =
      target === "linux"
        ? "./release/ZomboidControlPanel"
        : "./release/ZomboidControlPanel.exe";

    if (!sourceBinary) {
      console.error(`Missing build output for target: ${target}`);
      process.exit(1);
    }

    fs.copyFileSync(sourceBinary, targetBinary);
    if (target === "linux") {
      fs.chmodSync(targetBinary, 0o755);
    }

    builtArtifacts.push({
      platform: target,
      fileName: path.basename(targetBinary),
      absolutePath: path.resolve(targetBinary),
    });
  }

  console.log("Creating release package...");

  const clientDist = clientDistPath;
  const targetClientDist = "./release/client/dist";
  if (fs.existsSync(clientDist)) {
    fs.cpSync(clientDist, targetClientDist, { recursive: true });
  } else {
    console.error(
      'Client dist not found. Run "pnpm run build" in client first.',
    );
    process.exit(1);
  }

  const installDocsSrc = "./docs/install";
  const installDocsDest = "./release/docs/install";
  if (fs.existsSync(installDocsSrc)) {
    fs.mkdirSync(installDocsDest, { recursive: true });
    const guideFiles = fs
      .readdirSync(installDocsSrc)
      .filter((file) => file.endsWith(".md"));
    for (const file of guideFiles) {
      fs.copyFileSync(
        path.join(installDocsSrc, file),
        path.join(installDocsDest, file),
      );
    }
  } else {
    console.warn(
      "docs/install not found -- release will ship without install guides",
    );
  }

  fs.cpSync("./docs/releases", "./release/docs/releases", { recursive: true });

  fs.mkdirSync("./release/data", { recursive: true });

  const dataReadme = `data/ — Panel runtime database
=================================

panel.sqlite     Admin account, server profiles, settings, scheduled tasks,
                 mod tracking and operation history. Created on first run.
server-secrets/  Per-profile RCON credentials. Keep with the database.
backups/         Verified SQLite snapshots every six hours; newest five kept.
                 Damaged databases are preserved when a backup is restored.

Stop the panel before upgrading. Keep the entire data/ folder, including
secret files and backups. Release archives contain no seeded panel database.

Older db.sqlite and db.json files stay on disk. This rebuilt panel uses a
fresh panel.sqlite; create the admin account and register existing servers.
Project Zomboid saves, player data and config files are not reset.

Linux: tar xzf release.tar.gz --exclude='data/*'
Windows: extract everything except data/, or back up data/ first.
`;
  fs.writeFileSync("./release/data/README.txt", dataReadme);

  fs.mkdirSync("./release/logs", { recursive: true });
  fs.writeFileSync("./release/logs/.gitkeep", "");

  if (fs.existsSync("./integrations/argus")) {
    fs.cpSync("./integrations/argus", "./release/pz-mod", { recursive: true });
  }

  const wasmSrc = [
    "./node_modules/sql.js/dist/sql-wasm.wasm",
    "./apps/panel-server/node_modules/sql.js/dist/sql-wasm.wasm",
  ].find((candidate) => fs.existsSync(candidate));
  if (wasmSrc) {
    fs.copyFileSync(wasmSrc, "./release/sql-wasm.wasm");
  } else {
    console.warn(
      "sql-wasm.wasm not found in node_modules/sql.js/dist — vehicle cleanup will fail at runtime. Run `pnpm install` first.",
    );
  }

  if (fs.existsSync("./packaging/linux/zomboid-panel.service")) {
    fs.copyFileSync(
      "./packaging/linux/zomboid-panel.service",
      "./release/zomboid-panel.service",
    );
  }
  if (fs.existsSync("./packaging/linux/install-linux-service.sh")) {
    fs.copyFileSync(
      "./packaging/linux/install-linux-service.sh",
      "./release/install-linux-service.sh",
    );
    fs.chmodSync("./release/install-linux-service.sh", 0o755);
  }

  for (const compose of ["docker-compose.yml", "docker-compose.panel-only.yml"]) {
    fs.copyFileSync(`./${compose}`, `./release/${compose}`);
  }

  const startBat = generateStartBat();
  fs.writeFileSync("./release/Start.bat", startBat);

  const startSh = generateStartSh();
  fs.writeFileSync("./release/start.sh", startSh.replace(/\r\n/g, "\n"), {
    mode: 0o755,
  });

  const checksumLines = [];
  const manifestArtifacts = [];
  for (const artifact of builtArtifacts) {
    const checksum = sha256File(artifact.absolutePath);
    checksumLines.push(`${checksum}  ${artifact.fileName}`);
    manifestArtifacts.push({
      platform: artifact.platform,
      file: artifact.fileName,
      sha256: checksum,
    });
  }

  fs.writeFileSync("./release/checksums.txt", `${checksumLines.join("\n")}\n`);
  fs.writeFileSync(
    "./release/release-manifest.json",
    JSON.stringify(
      {
        version: panelVersion,
        buildSha,
        apiContractVersion,
        builtAt: new Date().toISOString(),
        hostPlatform: process.platform,
        targets,
        clientFiles: clientDistFileHashes,
        artifacts: manifestArtifacts,
      },
      null,
      2,
    ),
  );

  writeReleaseReadme();

  console.log("Release package created successfully");
  console.log("Location: ./release/");
  console.log("Contents:");
  for (const artifact of builtArtifacts) {
    console.log(`  - ${artifact.fileName} (${artifact.platform})`);
  }
  console.log("  - Start.bat");
  console.log("  - start.sh");
  console.log("  - checksums.txt");
  console.log("  - release-manifest.json");
  console.log("  - client/dist/");
  console.log("  - data/");
  console.log("  - logs/");
  console.log("  - pz-mod/");
  if (fs.existsSync("./release/docs/install")) {
    console.log("  - docs/install/");
  }
  if (fs.existsSync("./release/zomboid-panel.service")) {
    console.log("  - zomboid-panel.service");
  }
  if (fs.existsSync("./release/install-linux-service.sh")) {
    console.log("  - install-linux-service.sh");
  }
  console.log("  - docker-compose.yml");
  console.log("  - docker-compose.panel-only.yml");
  console.log("  - README.txt");

  if (targets.includes("linux")) {
    console.log("Packaging Linux release archive...");
    await createLinuxReleaseArchive(releaseDir, linuxArchiveStagingPath);
    fs.renameSync(linuxArchiveStagingPath, linuxArchivePath);
    console.log(`Wrote ${linuxArchivePath}`);
  }
}

const isMainModule =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
