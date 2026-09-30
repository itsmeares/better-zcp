import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import unzipper from "unzipper";
import { getAdmin, getServers, getDatabaseFilePath } from "../database/init.ts";
import { getDataPaths } from "../utils/paths.ts";
import { isContainerized } from "../utils/dockerDetect.ts";
import { getRestartAssessment, PANEL_SUPERVISOR_VERSION } from "./runtimeInfo.ts";
import { hashUpdatePath, stageUpdateBundle, readUpdateBundleJournalIfPresent, validateBuildCompatibility } from "./updateBundle.ts";
import { createLogger } from "../utils/logger.ts";

export { getRestartAssessment } from "./runtimeInfo.ts";
const log = createLogger("PanelUpdater");
const github = "https://api.github.com/repos/itsmeares/better-zcp";
const command = promisify(execFile);
type ReleaseAsset = { name: string; size: number; downloadUrl: string };
type LatestRelease = { version: string; tag: string; name: string; body: string; publishedAt: string | null; htmlUrl: string | null; assets: ReleaseAsset[] };

export function getPanelFolderPermissionGuidance(platform: string, detail: unknown) {
  return `Panel folder is not writable: ${detail}. ${platform === "win32" ? "Move the panel to a folder your account can write to." : "The service user must be able to write to the installation directory."}`;
}
export function getDevModeUpgradeInstruction(containerized = isContainerized()) {
  return containerized ? "Run the host update command shown in Settings." : "Pull the latest code with git, rebuild, and restart the panel.";
}
export function getDockerUpgradeInstruction(tag: string | null | undefined): string {
  if (["aio", "split"].includes(process.env.PANEL_DOCKER_INSTALL_KIND || "")) {
    const version = tag?.match(/^v(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/)?.[1];
    return version ? `curl -fsSL https://raw.githubusercontent.com/itsmeares/better-zcp/${tag}/infra/docker/all-in-one/bootstrap.sh | sh -s -- ${version}` : "";
  }
  return "docker compose pull panel && docker compose up -d --no-deps panel";
}
export function validateReleaseManifest(manifest: Record<string, any> | null, version: unknown, artifactName: string | null, hash: string | null) {
  if (!manifest || typeof manifest !== "object") return "Release archive does not contain a valid release manifest.";
  if (manifest.version !== version) return `Release archive version ${manifest.version || "unknown"} does not match release v${version}.`;
  const artifact = Array.isArray(manifest.artifacts) && manifest.artifacts.find(a => a?.file === artifactName);
  if (!artifact) return `Release manifest is missing the ${artifactName} artifact.`;
  if (typeof artifact.sha256 !== "string" || artifact.sha256.toLowerCase() !== hash?.toLowerCase()) return `Release manifest checksum does not match downloaded ${artifactName}.`;
  return null;
}

/** Redirects, byte limits and an absolute deadline apply to JSON and downloads alike. */
export async function fetchReleaseResponse(url: string, timeout = 15000): Promise<Response> {
  const signal = AbortSignal.timeout(timeout);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443") || !["github.com", "api.github.com", "githubusercontent.com"].includes(target.hostname) && !target.hostname.endsWith(".githubusercontent.com")) throw new Error("Release URL must use HTTPS on a trusted GitHub host.");
    const response = await fetch(target, { redirect: "manual", signal, headers: { "User-Agent": "Better-ZCP", Accept: "application/vnd.github+json" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Release redirect has no location.");
      url = new URL(location, target).href;
      continue;
    }
    return response;
  }
  throw new Error("Too many release redirects.");
}

async function releaseText(url: string, limit = 1024 * 1024): Promise<string> {
  const response = await fetchReleaseResponse(url);
  if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub returned HTTP ${response.status}.`); }
  let length = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body!) {
    length += chunk.length;
    if (length > limit) { await response.body?.cancel().catch(() => {}); throw new Error("Release response exceeds the size limit."); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeArchiveName(name: string): boolean {
  const normalized = name.replace(/\/$/, "");
  return normalized !== "" && !name.includes("\\") && !name.includes("\0") && !path.posix.isAbsolute(name) && normalized.split("/").every(part => part !== ".." && part !== "." && part !== "");
}

export async function extractUpdateArchive(archive: string, destination: string, windows: boolean): Promise<void> {
  if (windows) {
    const directory = await unzipper.Open.file(archive);
    let total = 0;
    for (const entry of directory.files) {
      if (!safeArchiveName(entry.path) || !["File", "Directory"].includes(entry.type) || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error("Unsafe release archive entry.");
      total += entry.uncompressedSize;
    }
    if (total > 1024 * 1024 * 1024) throw new Error("Release archive is too large.");
    await directory.extract({ path: destination });
  } else {
    const options = { timeout: 120000, maxBuffer: 8 * 1024 * 1024 };
    const [{ stdout: names }, { stdout: types }] = await Promise.all([
      command("tar", ["-tzf", archive], options), command("tar", ["-tvzf", archive], options),
    ]);
    if (names.trim().split("\n").some(name => !safeArchiveName(name)) || types.trim().split("\n").some(line => !["-", "d"].includes(line[0]))) throw new Error("Unsafe release archive entry.");
    await command("tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", destination], options);
  }
}

export class PanelUpdateChecker {
  io: any;
  currentVersion: string | null = null;
  latestRelease: LatestRelease | null = null;
  updateAvailable = false;
  isChecking = false;
  isDownloading = false;
  isApplying = false;
  downloadProgress = 0;
  lastCheck: string | null = null;
  lastError: string | null = null;
  checkInterval: ReturnType<typeof setInterval> | null = null;
  initialTimeout: ReturnType<typeof setTimeout> | null = null;
  constructor(io?: any) { this.io = io; }
  start(version: string) {
    this.currentVersion = version;
    this.stop();
    this.initialTimeout = setTimeout(() => void this.checkForUpdate(), 30000);
    this.checkInterval = setInterval(() => void this.checkForUpdate(), 6 * 3600000);
  }
  stop() {
    if (this.initialTimeout) clearTimeout(this.initialTimeout);
    if (this.checkInterval) clearInterval(this.checkInterval);
    this.initialTimeout = this.checkInterval = null;
  }
  extractVersion(tag: unknown): string | null {
    return typeof tag === "string" && /^v?\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag) ? tag.replace(/^v/, "") : null;
  }
  isNewer(latest: string, current: string): boolean {
    const [a, apre] = latest.split("-"), [b, bpre] = current.split("-");
    const aa = a.split(".").map(Number), bb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) > (bb[i] || 0);
    if (apre === bpre) return false;
    if (!apre || !bpre) return !apre;
    // This project's release tags use rc5/rc10, so compare their numeric suffix naturally.
    return apre.localeCompare(bpre, "en", { numeric: true }) > 0;
  }
  async checkForUpdate() {
    if (this.isChecking) return this.getStatus();
    this.isChecking = true;
    try {
      const prerelease = Boolean(this.currentVersion?.includes("-"));
      const response = await fetchReleaseResponse(`${github}/releases${prerelease ? "?per_page=20" : "/latest"}`);
      if (response.status === 404) { await response.body?.cancel(); this.latestRelease = null; this.updateAvailable = false; }
      else {
        if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub returned HTTP ${response.status}.`); }
        let text = "";
        for await (const chunk of response.body!) { text += Buffer.from(chunk).toString(); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Release response is too large."); }
        const payload: unknown = JSON.parse(text);
        const releases = prerelease ? payload : [payload];
        if (!Array.isArray(releases)) throw new Error("Invalid GitHub release response.");
        const candidates = releases.filter(r => r && !r.draft && this.extractVersion(r.tag_name) && (prerelease || !r.prerelease));
        candidates.sort((a, b) => this.isNewer(this.extractVersion(a.tag_name)!, this.extractVersion(b.tag_name)!) ? -1 : 1);
        const release = candidates[0];
        this.latestRelease = release ? {
          version: this.extractVersion(release.tag_name)!, tag: release.tag_name, name: String(release.name || release.tag_name), body: String(release.body || ""),
          publishedAt: release.published_at || null, htmlUrl: release.html_url || null,
          assets: Array.isArray(release.assets) ? release.assets.filter((asset: any) => typeof asset.name === "string" && Number.isSafeInteger(asset.size) && asset.size > 0 && typeof asset.browser_download_url === "string").map((asset: any) => ({ name: asset.name, size: asset.size, downloadUrl: asset.browser_download_url })) : [],
        } : null;
        this.updateAvailable = Boolean(this.latestRelease && this.currentVersion && this.isNewer(this.latestRelease.version, this.currentVersion));
      }
      this.lastError = null;
      this.lastCheck = new Date().toISOString();
      this.io?.emit("panel:updateStatus", this.getStatus());
      if (this.updateAvailable) this.io?.emit("panel:updateAvailable", this.getStatus());
    } catch (e) { this.lastError = (e as Error).message; log.warn(this.lastError); }
    finally { this.isChecking = false; this.io?.emit("panel:updateStatus", this.getStatus()); }
    return this.getStatus();
  }
  getExeBasePath() { return process.execPath; }
  isSupervisorAvailable() { return process.env.PANEL_SUPERVISOR_V === PANEL_SUPERVISOR_VERSION; }
  getStagedUpdate() {
    if (typeof process.pkg === "undefined" || isContainerized()) return null;
    const journalPath = path.join(path.dirname(this.getExeBasePath()), "update-bundle.json");
    const journal = readUpdateBundleJournalIfPresent(journalPath);
    if (!journal || journal.phase !== "staged") return null;
    const stagedPath = path.join(path.dirname(journalPath), `.panel-update-${journal.transactionId}`, path.basename(this.getExeBasePath()));
    return { version: journal.version, stagedPath, path: stagedPath, journalPath };
  }
  getStatus() {
    const staged = this.getStagedUpdate();
    let lastApplyResult = null;
    if (typeof process.pkg !== "undefined" && !isContainerized()) {
      try { const result = this.readMostRecentApplyLog(); lastApplyResult = result ? JSON.parse(result) : null; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.warn("Could not read update result."); }
    }
    return { currentVersion: this.currentVersion, latestVersion: this.latestRelease?.version || null, updateAvailable: this.updateAvailable,
      releaseUrl: this.latestRelease?.htmlUrl || null, releaseNotes: this.latestRelease?.body || null, publishedAt: this.latestRelease?.publishedAt || null,
      isChecking: this.isChecking, isDownloading: this.isDownloading, isApplying: this.isApplying, downloadProgress: this.downloadProgress, lastCheck: this.lastCheck, lastError: this.lastError,
      updateMode: isContainerized() ? "docker" : "binary", updateCommand: isContainerized() ? getDockerUpgradeInstruction(this.latestRelease?.tag) || null : null,
      dockerInstallKind: isContainerized() && ["aio", "split"].includes(process.env.PANEL_DOCKER_INSTALL_KIND || "") ? process.env.PANEL_DOCKER_INSTALL_KIND : null,
      stagedUpdate: staged ? { version: staged.version, path: staged.stagedPath } : null, lastApplyResult };
  }
  async preflight() {
    const blockers: string[] = [], warnings: string[] = [];
    const install = path.dirname(this.getExeBasePath());
    const paths = getDataPaths();
    const info: Record<string, any> = { isPackaged: typeof process.pkg !== "undefined", platform: process.platform, updateMode: isContainerized() ? "docker" : "binary", restartAssessment: getRestartAssessment(), exeDir: install, exePath: this.getExeBasePath(), dataDir: paths.dataDir, dbPath: getDatabaseFilePath(), applyLogPath: path.join(install, "panel-update-result.json") };
    if (isContainerized()) blockers.push("Docker panel updates run from the host. Game containers keep running.");
    else if (!info.isPackaged) blockers.push(`Self-update requires a native package. ${getDevModeUpgradeInstruction(false)}`);
    else {
      if (!["win32", "linux"].includes(process.platform) || process.arch !== "x64") blockers.push("No native update package supports this platform.");
      if (!this.isSupervisorAvailable()) blockers.push("Restart the panel using the launcher supplied with this package before updating.");
      try { await getAdmin(); await getServers(); info.databaseReadable = true; } catch (e) { blockers.push(`Panel database cannot be read: ${(e as Error).message}`); }
      let probe: string | undefined;
      try { probe = fs.mkdtempSync(path.join(install, ".panel-write-probe-")); info.writable = true; }
      catch (e) { blockers.push(getPanelFolderPermissionGuidance(process.platform, (e as Error).message)); }
      finally { if (probe) fs.rmSync(probe, { recursive: true }); }
      const archive = this.archiveAsset();
      if (this.latestRelease && (!archive || !this.latestRelease.assets.some(a => a.name === "checksums.txt"))) blockers.push("Release must include the platform archive and checksums.txt.");
      if (archive) {
        try {
          const stat = fs.statfsSync(install); info.freeBytes = Number(stat.bavail) * Number(stat.bsize);
          const binary = this.latestRelease!.assets.find(a => a.name === (process.platform === "win32" ? "ZomboidControlPanel.exe" : "ZomboidControlPanel"));
          const required = archive.size + 2 * (binary?.size || archive.size * 4) + fs.statSync(info.dbPath).size;
          if (info.freeBytes < required) blockers.push(`Not enough disk space. Need at least ${Math.ceil(required / 1024 / 1024)} MB.`);
        } catch { warnings.push("Free disk space could not be checked. Verify space for the package and rollback backup before updating."); }
      }
    }
    return { ok: blockers.length === 0, blockers, warnings, blockerDetails: [], warningDetails: [], info };
  }
  private archiveAsset() { return this.latestRelease?.assets.find(a => a.name === (process.platform === "win32" ? "ZomboidControlPanel-windows.zip" : "ZomboidControlPanel-linux.tar.gz")); }
  async downloadFile(url: string, destination: string, expectedSize: number) {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 1024 * 1024 * 1024) throw new Error("Invalid release asset size.");
    const response = await fetchReleaseResponse(url, 10 * 60000);
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Download failed: HTTP ${response.status}.`); }
    let received = 0, lastProgress = -1, created = false;
    try {
      const descriptor = fs.openSync(destination, "wx", 0o600);
      created = true;
      await pipeline(Readable.fromWeb(response.body as any), new Transform({ transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        if (received > expectedSize) { callback(new Error("Downloaded asset exceeds the published size.")); return; }
        this.downloadProgress = Math.floor(received / expectedSize * 100);
        if (this.downloadProgress >= lastProgress + 5) { lastProgress = this.downloadProgress; this.io?.emit("panel:downloadProgress", { progress: this.downloadProgress, status: "downloading" }); }
        callback(null, chunk);
      } }), fs.createWriteStream(destination, { fd: descriptor, autoClose: true }));
      if (received !== expectedSize) throw new Error("Downloaded asset size does not match the release.");
    } catch (e) { if (created) fs.rmSync(destination, { force: true }); else await response.body?.cancel().catch(() => {}); throw e; }
  }
  async downloadUpdate() {
    if (isContainerized()) return { success: false, code: "docker_manual_update", error: "Docker images must be updated from the host. See the update command in Settings." };
    if (this.isDownloading || this.isApplying) return { success: false, code: "already_downloading", error: "A panel update is already in progress." };
    if (!this.updateAvailable || !this.latestRelease) return { success: false, code: "no_update", error: "No update available." };
    this.isDownloading = true;
    this.downloadProgress = 0;
    let temporary: string | undefined;
    try {
      const preflight = await this.preflight();
      if (!preflight.ok) return { success: false, preflight, error: preflight.blockers[0] };
      const release = this.latestRelease, asset = this.archiveAsset()!;
      const checksums = release.assets.find(a => a.name === "checksums.txt")!;
      const lines = await releaseText(checksums.downloadUrl, 64 * 1024);
      const checksum = lines.split(/\r?\n/).map(line => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).find(match => match?.[2] === asset.name)?.[1]?.toLowerCase();
      if (!checksum) throw new Error("Release archive has no published SHA256 checksum.");
      temporary = fs.mkdtempSync(path.join(path.dirname(this.getExeBasePath()), ".panel-download-"));
      const archive = path.join(temporary, asset.name), unpacked = path.join(temporary, "unpacked");
      await this.downloadFile(asset.downloadUrl, archive, asset.size);
      if (hashUpdatePath(archive) !== checksum) throw new Error("Release archive SHA256 checksum does not match.");
      fs.mkdirSync(unpacked);
      await extractUpdateArchive(archive, unpacked, process.platform === "win32");
      const binaryName = path.basename(this.getExeBasePath());
      const binary = path.join(unpacked, binaryName), client = path.join(unpacked, "client/dist");
      const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "release-manifest.json"), "utf8"));
      const manifestError = validateReleaseManifest(manifest, release.version, binaryName, hashUpdatePath(binary));
      if (manifestError) throw new Error(manifestError);
      const metadata = { panelVersion: manifest.version, buildSha: manifest.buildSha, apiContractVersion: manifest.apiContractVersion };
      if (!validateBuildCompatibility(JSON.parse(fs.readFileSync(path.join(client, "build-info.json"), "utf8")), metadata).compatible) throw new Error("Release frontend and backend builds do not match.");
      const header = Buffer.alloc(4), fd = fs.openSync(binary, "r");
      try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (process.platform === "win32" ? header.subarray(0, 2).toString() !== "MZ" : !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error("Release binary does not match this platform.");
      const names = process.platform === "win32" ? ["Start.bat", "sql-wasm.wasm"] : ["start.sh", "zomboid-panel.service", "install-linux-service.sh", "sql-wasm.wasm"];
      const managedFiles = Object.fromEntries(names.map(name => [name, path.join(unpacked, name)]));
      if (process.platform !== "win32") for (const name of [binaryName, "start.sh", "install-linux-service.sh"]) fs.chmodSync(path.join(unpacked, name), 0o755);
      stageUpdateBundle({ installDir: path.dirname(this.getExeBasePath()), version: release.version, binaryPath: this.getExeBasePath(), stagedBinaryPath: binary, liveClientPath: path.join(path.dirname(this.getExeBasePath()), "client/dist"), incomingClientPath: client, metadata, managedFiles });
      this.lastError = null;
      this.io?.emit("panel:updateReady", { version: release.version });
      return { success: true, message: `Verified v${release.version}. Ready to restart the panel.` };
    } catch (e) { this.lastError = (e as Error).message; return { success: false, error: this.lastError }; }
    finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); this.isDownloading = false; }
  }
  readMostRecentApplyLog() {
    const file = path.join(path.dirname(this.getExeBasePath()), "panel-update-result.json");
    let descriptor: number | undefined;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 65536) throw new Error("Update result is not a bounded regular file.");
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error("Update result changed while opening.");
      const buffer = Buffer.alloc(65537);
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (count > 65536) throw new Error("Update result is too large.");
      return buffer.subarray(0, count).toString("utf8");
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
}
