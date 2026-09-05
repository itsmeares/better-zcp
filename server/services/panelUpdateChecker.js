/**
 * Panel Update Checker
 *
 * Checks for new panel releases on GitHub and provides a self-update mechanism.
 * - Periodically checks github.com/itsmeares/better-zcp/releases
 * - Compares installed version vs latest GitHub release
 * - Downloads and replaces the binary for one-click updates (exe mode only)
 */

import fs from "fs";
import os from "os";
import path from "path";
import https from "https";
import crypto from "crypto";
import { spawn } from "child_process";
import { createLogger } from "../utils/logger.js";
import { getSetting, setSetting } from "../database/init.js";
import { getDataPaths } from "../utils/paths.js";
import { DockerUpdateProxy } from "./dockerUpdateProxy.js";
import { isContainerized } from "../utils/dockerDetect.js";
import { stageUpdateBundle } from "./updateBundle.js";

const log = createLogger("PanelUpdater");

const GITHUB_OWNER = "itsmeares";
const GITHUB_REPO = "better-zcp";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check every 6 hours
const GITHUB_API_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_GITHUB_RETRIES = 3;
const MAX_DOWNLOAD_REDIRECTS = 5;

export function getPanelFolderPermissionGuidance(platform, detail) {
  const prefix = `Panel folder is not writable by this process: ${detail}.`;
  if (platform === "win32") {
    return `${prefix} Try running as Administrator, or move the panel out of a protected folder.`;
  }
  if (platform === "linux") {
    return `${prefix} Check that the panel service user owns the installation directory and can write to it.`;
  }
  return `${prefix} Check the installation directory permissions for the account running the panel.`;
}

// A Linux install whose loaded systemd unit predates KillMode=process (or
// whose launcher predates start.sh's own process-group isolation) reads as
// "at risk": a panel restart signals the whole cgroup, which can also kill
// every running game server. PANEL_SUPERVISOR_V/PANEL_PRESERVE_GAME_SERVERS
// are set by the NEW start.sh only, so their absence under an orchestrator
// means the OLD unit/launcher shape is still the one actually loaded —
// see remediationCommand below for what an operator does about it.
export function getRestartAssessment({
  platform = process.platform,
  packaged = typeof process.pkg !== "undefined",
  environment = process.env,
  exeDir = path.dirname(process.execPath),
  launcherProtected =
    environment.PANEL_SUPERVISOR_V === "2" &&
    environment.PANEL_PRESERVE_GAME_SERVERS === "1",
} = {}) {
  const orchestrated = Boolean(
    environment.INVOCATION_ID || environment.NOTIFY_SOCKET || environment.RC_SVCNAME,
  );

  if (!packaged) {
    return {
      gameServers: "unknown",
      requiresConfirmation: true,
      reason: "development-runtime",
    };
  }
  if (platform === "win32") {
    return {
      gameServers: "preserved",
      requiresConfirmation: false,
      reason: "detached-windows-process",
    };
  }
  if (platform === "linux" && orchestrated && launcherProtected) {
    return {
      gameServers: "preserved",
      requiresConfirmation: false,
      reason: "isolated-linux-supervisor",
    };
  }
  if (platform === "linux" && orchestrated) {
    return {
      gameServers: "at-risk",
      requiresConfirmation: true,
      reason: "service-cgroup-may-stop-children",
      // install-linux-service.sh is idempotent (no-ops if the unit already
      // matches) and never invokes sudo itself, so this is safe to hand to
      // an operator verbatim regardless of how far out of date they are.
      remediationCommand: `sudo ${path.join(exeDir, "install-linux-service.sh")} --enable`,
    };
  }
  return {
    gameServers: platform === "linux" ? "preserved" : "unknown",
    requiresConfirmation: platform !== "linux",
    reason: platform === "linux" ? "detached-linux-process" : "unknown-runtime",
  };
}

// "In dev mode, pull the latest code with git" is only true for a real git
// checkout run with plain `node server/index.js`. Someone running the
// published Docker image has no checkout to pull — the correct next step is
// to pull and recreate the image via Compose.
export function getDevModeUpgradeInstruction(containerized = isContainerized()) {
  return containerized
    ? "Pull the newer image and recreate the container: docker compose pull && docker compose up -d."
    : "In dev mode, pull the latest code with git.";
}

function addPreflightMessage(messages, details, key, params, fallback) {
  messages.push(fallback);
  details.push({ key, params });
}

export function createUpdateDataBackup(dataPaths, version, fsModule = fs) {
  const dbPath = dataPaths?.dbPath;
  if (!dbPath || !fsModule.existsSync(dbPath)) return null;
  const safeVersion = String(version || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  const backupPath = `${dbPath}.pre-update-${safeVersion}-${Date.now()}`;
  const tempPath = `${backupPath}.tmp`;
  fsModule.copyFileSync(dbPath, tempPath);
  try {
    fsModule.renameSync(tempPath, backupPath);
  } catch (error) {
    try { fsModule.unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
  return backupPath;
}

/**
 * Restore db.json from a pre-update snapshot (see createUpdateDataBackup()
 * above) after a rollback that can only be needed on ONE path: the update
 * bundle journal's version-mismatch rollback (updateBundle.js's
 * acknowledgeUpdateBundle()), which fires AFTER the new binary has already
 * completed its own startup -- including any database migration -- and
 * only rolls the BINARY and CLIENT back. Without this, that rollback is a
 * half-rollback: the previous binary running against a database the NEW
 * version already migrated. The bundle-transaction's OWN mid-apply rollback
 * (applyUpdateBundle() failing before the new binary ever ran) never needs
 * this -- nothing could have touched the database yet at that point.
 *
 * Returns false (never throws for a missing/absent backup -- that's the
 * caller's own thing to log, not this function's) when there is nothing to
 * restore. Propagates a real copy failure so the caller can tell the two
 * apart.
 */
export function restorePreUpdateDataBackup(dataPaths, backupPath, fsModule = fs) {
  const dbPath = dataPaths?.dbPath;
  if (!dbPath || !backupPath || !fsModule.existsSync(backupPath)) return false;
  fsModule.copyFileSync(backupPath, dbPath);
  return true;
}

export function validateReleaseManifest(
  manifest,
  expectedVersion,
  artifactName,
  artifactHash,
) {
  if (!manifest || typeof manifest !== "object") {
    return "Release archive does not contain a valid release manifest.";
  }
  if (manifest.version !== expectedVersion) {
    return `Release archive version ${manifest.version || "unknown"} does not match release v${expectedVersion}.`;
  }
  if (!artifactName) return null;

  const artifact = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.find((candidate) => candidate?.file === artifactName)
    : null;
  if (!artifact) {
    return `Release manifest is missing the ${artifactName} artifact.`;
  }
  if (
    artifactHash &&
    String(artifact.sha256).toLowerCase() !== artifactHash.toLowerCase()
  ) {
    return `Release manifest checksum does not match downloaded ${artifactName}.`;
  }
  return null;
}

export class PanelUpdateChecker {
  constructor(io) {
    this.io = io;
    this.checkInterval = null;
    this.initialTimeout = null;
    this.latestRelease = null;
    this.currentVersion = null;
    this.updateAvailable = false;
    this.isChecking = false;
    this.isDownloading = false;
    this.downloadProgress = 0;
    this.lastCheck = null;
    this.lastError = null;
    this.dockerUpdateProxy = new DockerUpdateProxy();
    // Set when a Windows apply helper has been spawned (or Linux apply has
    // started). Prevents a second concurrent /api/panel/restart from
    // spawning a second helper that would race for the staged file.
    this.isApplying = false;
  }

  /**
   * Start the panel update checker
   */
  async start(currentVersion) {
    this.currentVersion = currentVersion || "0.0.0";
    log.info(`Panel update checker started (current: v${this.currentVersion})`);

    // Load persisted staged-version cache BEFORE reconcile so the banner
    // reports the correct staged version even if `latestRelease` has drifted.
    await this.loadStagedVersionCache();

    // Confirm or report on any update that was pending from a previous run.
    // This runs once at startup so the client can see a success/failure banner.
    try {
      await this.reconcilePendingUpdate();
    } catch (err) {
      log.warn(`Could not reconcile pending panel update: ${err.message}`);
    }

    // Legacy Windows applies may leave helper scripts in the runtime temp
    // directory. Keep the last few logs for post-mortem debugging and remove
    // older ones so they do not accumulate forever on long-running installs.
    try {
      this.cleanupOldHelperArtifacts();
    } catch (err) {
      log.debug(`Helper artifact cleanup failed: ${err.message}`);
    }

    // Sweep orphan .partial.* files left over from downloads that were
    // killed mid-stream (panel crashed, machine rebooted, etc). These are
    // safe to delete: a real .partial belonging to an in-progress download
    // would be inside our own process — we just started up, so nothing is
    // in-progress yet.
    try {
      this.cleanupOrphanPartials();
    } catch (err) {
      log.debug(`Orphan partial cleanup failed: ${err.message}`);
    }

    // Initial check after 30 seconds
    this.initialTimeout = setTimeout(() => this.checkForUpdate(), 30000);

    // Periodic checks
    this.checkInterval = setInterval(
      () => this.checkForUpdate(),
      CHECK_INTERVAL_MS,
    );
  }

  /**
   * Stop the checker
   */
  stop() {
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Check GitHub for the latest release
   */
  async checkForUpdate() {
    if (this.isChecking) return this.getStatus();
    this.isChecking = true;
    this.lastCheck = new Date().toISOString();

    try {
      const release = await this.fetchLatestRelease();
      if (!release) {
        this.lastError = null;
        this.isChecking = false;
        return this.getStatus();
      }

      const releaseVersion = this.extractVersion(release.tag_name);
      if (!releaseVersion) {
        throw new Error(
          "Latest GitHub release is missing a valid version tag.",
        );
      }

      this.latestRelease = {
        version: releaseVersion,
        tag: release.tag_name,
        name:
          typeof release.name === "string" ? release.name : release.tag_name,
        body: typeof release.body === "string" ? release.body : "",
        publishedAt: release.published_at || null,
        htmlUrl: release.html_url || null,
        assets: (release.assets || []).map((a) => ({
          name: a.name,
          size: a.size,
          downloadUrl: a.browser_download_url,
        })),
      };

      this.updateAvailable = this.isNewer(
        this.latestRelease.version,
        this.currentVersion,
      );
      this.lastError = null;

      if (this.updateAvailable) {
        log.info(
          `Panel update available: v${this.currentVersion} → v${this.latestRelease.version}`,
        );
        this.io?.emit("panel:updateAvailable", {
          currentVersion: this.currentVersion,
          latestVersion: this.latestRelease.version,
          releaseUrl: this.latestRelease.htmlUrl,
        });
      } else {
        log.debug(`Panel is up to date (v${this.currentVersion})`);
      }
    } catch (error) {
      this.lastError = error.message;
      log.warn(`Panel update check failed: ${error.message}`);
    } finally {
      this.isChecking = false;
    }

    return this.getStatus();
  }

  /**
   * Fetch the latest release from GitHub API
   */
  fetchLatestRelease() {
    return this.requestGitHubReleaseWithRetry();
  }

  async requestGitHubReleaseWithRetry() {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_GITHUB_RETRIES; attempt += 1) {
      try {
        return await this.fetchLatestReleaseOnce();
      } catch (error) {
        lastError = error;
        if (
          !this.isRetryableGitHubError(error) ||
          attempt === MAX_GITHUB_RETRIES
        ) {
          break;
        }

        const backoffMs = attempt * 1000;
        log.warn(
          `Panel update check attempt ${attempt} failed (${error.message}). Retrying in ${backoffMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw lastError || new Error("Unknown GitHub update check failure");
  }

  fetchLatestReleaseOnce() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: "api.github.com",
        path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        headers: {
          "User-Agent": `ZomboidControlPanel/${this.currentVersion}`,
          Accept: "application/vnd.github.v3+json",
        },
      };

      const req = https.get(options, (res) => {
        // Both branches below only ever resolve/reject from res's own
        // "data"/"end" events -- if the connection dies mid-body-read (the
        // response already exists, only its body is incomplete) in a way
        // Node surfaces on `res` rather than re-propagating to `req`'s own
        // "error" listener below, neither branch's "end" fires and this
        // promise never settles. checkForUpdate()'s try/finally only resets
        // isChecking once its `await` on this actually settles, so an
        // unsettled promise here latches isChecking true forever and no
        // later scheduled check ever runs. Settling is idempotent (a
        // Promise only honors its first resolve/reject), so this is safe to
        // wire unconditionally alongside the two branches' own resolve/reject
        // calls without an extra guard flag.
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("GitHub response aborted")));

        const statusCode = res.statusCode || 0;

        if (statusCode === 404) {
          res.resume();
          resolve(null);
          return;
        }

        if (statusCode !== 200) {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk.toString();
            if (body.length > 4096) body = body.slice(0, 4096);
          });
          res.on("end", () => {
            const err = new Error(
              statusCode === 403
                ? "GitHub API rate limited"
                : `GitHub API returned ${statusCode}`,
            );
            err.statusCode = statusCode;
            if (body.includes("rate limit")) {
              err.rateLimited = true;
            }
            reject(err);
          });
          return;
        }

        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed || typeof parsed !== "object") {
              throw new Error("Invalid GitHub release payload");
            }
            resolve(parsed);
          } catch (_) {
            reject(new Error("Failed to parse GitHub response"));
          }
        });
      });

      req.on("error", reject);
      req.setTimeout(GITHUB_API_TIMEOUT_MS, () => {
        const timeoutError = new Error("GitHub API timeout");
        timeoutError.code = "ETIMEDOUT";
        req.destroy(timeoutError);
      });
    });
  }

  isRetryableGitHubError(error) {
    const statusCode = error?.statusCode;
    const code = error?.code;
    if ([408, 429, 500, 502, 503, 504].includes(statusCode)) return true;
    if (
      code &&
      ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND"].includes(code)
    )
      return true;
    return Boolean(error?.rateLimited);
  }

  extractVersion(tag) {
    if (typeof tag !== "string") return null;
    const match = tag.match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    return match[4]
      ? `${match[1]}.${match[2]}.${match[3]}.${match[4]}`
      : `${match[1]}.${match[2]}.${match[3]}`;
  }

  /**
   * Compare semver-ish versions (supports 3 or 4 parts). Returns true if latest > current.
   */
  isNewer(latest, current) {
    const normalize = (v) => {
      const match = v.match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
      if (!match) return [0, 0, 0, 0];
      return [
        parseInt(match[1]),
        parseInt(match[2]),
        parseInt(match[3]),
        parseInt(match[4] || "0"),
      ];
    };

    const [lMajor, lMinor, lPatch, lHotfix] = normalize(latest);
    const [cMajor, cMinor, cPatch, cHotfix] = normalize(current);

    if (lMajor !== cMajor) return lMajor > cMajor;
    if (lMinor !== cMinor) return lMinor > cMinor;
    if (lPatch !== cPatch) return lPatch > cPatch;
    return lHotfix > cHotfix;
  }

  /**
   * Download the update binary and prepare for restart
   */
  async downloadUpdate() {
    if (this.isDownloading) {
      return {
        success: false,
        error: "Download already in progress",
        code: "already_downloading",
      };
    }
    if (this.isApplying) {
      // Refuse to start a new download while a helper is mid-apply — that
      // could overwrite the staged file the helper is about to rename.
      return {
        success: false,
        error: "An update apply is already in progress",
        code: "apply_in_progress",
      };
    }
    if (!this.updateAvailable || !this.latestRelease) {
      return {
        success: false,
        error: "No update available",
        code: "no_update",
      };
    }

    // Preflight gates the download — we refuse to stage anything if we already
    // know the apply step will fail (no write permission, no disk space, etc).
    const pre = await this.preflight();
    if (!pre.ok) {
      return {
        success: false,
        error: pre.blockers[0] || "Preflight check failed",
        preflight: pre,
      };
    }

    if (this.dockerUpdateProxy.enabled) {
      const version = this.latestRelease.version;
      this.isDownloading = true;
      try {
        return await this.dockerUpdateProxy.apply(version);
      } catch (error) {
        this.lastError = error.message;
        return { success: false, error: error.message };
      } finally {
        this.isDownloading = false;
      }
    }

    const isWindows = process.platform === "win32";
    const isPackaged = typeof process.pkg !== "undefined";

    if (!isPackaged) {
      return {
        success: false,
        error: `Self-update is only available for standalone exe/binary builds. ${getDevModeUpgradeInstruction()}`,
      };
    }

    // Stage the executable separately and refresh client/dist from the matching
    // archive. Standalone builds serve that directory beside the binary.
    const assetName = isWindows
      ? "ZomboidControlPanel.exe"
      : "ZomboidControlPanel";
    const isArchive = (name) => /\.(zip|tar\.gz|tgz|7z|rar)$/i.test(name || "");

    let asset = this.latestRelease.assets.find((a) => a.name === assetName);
    if (!asset) {
      // Conservative fallback: require the raw extension/shape and exclude archives.
      if (isWindows) {
        asset = this.latestRelease.assets.find(
          (a) => /\.exe$/i.test(a.name) && !isArchive(a.name),
        );
      } else {
        asset = this.latestRelease.assets.find(
          (a) =>
            !isArchive(a.name) &&
            !/\.exe$/i.test(a.name) &&
            a.name.toLowerCase().includes("linux"),
        );
      }
    }

    if (!asset) {
      return {
        success: false,
        error: `No ${isWindows ? "Windows" : "Linux"} binary found in release (looked for ${assetName})`,
      };
    }

    const archiveName = isWindows
      ? "ZomboidControlPanel-windows.zip"
      : "ZomboidControlPanel-linux.tar.gz";
    const clientArchive = this.latestRelease.assets.find(
      (candidate) => candidate.name === archiveName,
    );
    if (!clientArchive) {
      return {
        success: false,
        error: `Release is missing ${archiveName}, required to update the web interface safely.`,
      };
    }

    this.isDownloading = true;
    this.downloadProgress = 0;
    this.lastError = null;

    const exePath = process.execPath;
    const exeDir = path.dirname(exePath);
    // Since v1.0.17 the apply helper launches the staged file in place (no
    // rename) so AV never sees a fresh write at the canonical .exe path. That
    // means the *currently running* process may itself be a staged file
    // (ends in .new or .new2). We must stage into a slot that is NOT the file
    // we're running from, otherwise we'd try to overwrite our own binary.
    const stagedPath = this.getStageSlotPath();
    const tmpDownloadPath = `${stagedPath}.partial.${process.pid}`;
    const clientArchiveExtension = isWindows ? ".zip" : ".tar.gz";
    const tmpClientArchivePath = path.join(
      exeDir,
      `.client-dist-${this.latestRelease.version}.partial.${process.pid}${clientArchiveExtension}`,
    );
    let incomingClientPath = null;

    try {
      // Take the database snapshot immediately before the destructive apply,
      // not when the update is downloaded. Staging and applying may be hours
      // apart, so an earlier snapshot would miss later state changes.
      log.info(
        `Downloading update: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`,
      );
      this.io?.emit("panel:downloadProgress", {
        progress: 0,
        status: "downloading",
      });

      // Clear any prior staged file so we always download fresh
      try {
        if (fs.existsSync(tmpDownloadPath)) fs.unlinkSync(tmpDownloadPath);
      } catch (cleanErr) {
        log.debug(`Failed to clean partial file: ${cleanErr.message}`);
      }

      await this.downloadFile(asset.downloadUrl, tmpDownloadPath, asset.size);

      log.info("Download complete, staging update...");
      this.io?.emit("panel:downloadProgress", {
        progress: 100,
        status: "preparing",
      });

      // Cryptographic integrity check against the published checksums.txt.
      // Size + magic bytes already ruled out HTML error pages and wrong-asset
      // confusion. SHA256 additionally rules out silent corruption in transit
      // and supply-chain tampering on the mirror edge. Older releases may not
      // ship checksums.txt — treat that as a warning, not a failure.
      try {
        const verified = await this.verifyChecksum(tmpDownloadPath, asset.name);
        if (verified === false) {
          throw new Error(
            "SHA256 checksum mismatch — download corrupted or tampered with",
          );
        }
        if (verified === null) {
          // Fail CLOSED, not open: a release with no checksums.txt (or no
          // entry for this asset) could be a tampered/mis-published release,
          // and integrity would otherwise rest entirely on the GitHub
          // account + TLS. The release pipeline always publishes checksums.txt, so a
          // release missing it is unexpected and should not be auto-applied.
          throw new Error(
            `Release v${this.latestRelease.version} does not publish a checksums.txt entry for ${asset.name} — refusing to apply an unverified update`,
          );
        }
        log.info(`SHA256 verified against release checksums.txt`);
      } catch (verifyErr) {
        // Any thrown error from verifyChecksum is a hard stop: either the
        // checksum mismatched or the verification logic failed fatally.
        try {
          fs.unlinkSync(tmpDownloadPath);
        } catch {
          /* best effort */
        }
        throw verifyErr;
      }

      await this.downloadFile(
        clientArchive.downloadUrl,
        tmpClientArchivePath,
        clientArchive.size,
        "archive",
      );
      const archiveVerified = await this.verifyChecksum(
        tmpClientArchivePath,
        clientArchive.name,
      );
      if (archiveVerified !== true) {
        throw new Error(
          `Could not verify ${clientArchive.name}; refusing to replace the web interface`,
        );
      }
      const stagedClient = await this.stageClientDist(
        tmpClientArchivePath,
        isWindows,
        tmpDownloadPath,
        asset.name,
      );
      incomingClientPath = stagedClient.incomingClientPath;
      fs.unlinkSync(tmpClientArchivePath);

      // Promote .partial → .new atomically. If a stale .new exists, drop it first.
      try {
        if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
      } catch (cleanErr) {
        log.debug(`Failed to clean stale staged file: ${cleanErr.message}`);
      }
      fs.renameSync(tmpDownloadPath, stagedPath);

      if (!isWindows) {
        try {
          fs.chmodSync(stagedPath, 0o755);
        } catch (chmodErr) {
          log.warn(`Could not chmod staged binary: ${chmodErr.message}`);
        }
      }

      const exeBasePath = this.getExeBasePath();
      const journalPath = stageUpdateBundle({
        installDir: exeDir,
        version: this.latestRelease.version,
        binaryPath: exeBasePath,
        stagedBinaryPath: stagedPath,
        liveClientPath: path.join(exeDir, "client", "dist"),
        incomingClientPath,
        metadata: stagedClient.metadata,
      });
      fs.rmSync(incomingClientPath, { recursive: true, force: true });
      incomingClientPath = null;

      // NOTE: We intentionally do NOT set `pendingPanelUpdate` here. That
      // setting is the "we actually committed to apply this" marker used by
      // reconcilePendingUpdate() on next boot. Setting it at download time
      // would cause a false-positive "Update Failed to Apply" banner if the
      // user downloads but never clicks Restart and Apply. The restart
      // endpoint writes it right before exit instead.
      //
      // But we DO persist the staged version separately so `getStagedUpdate()`
      // can report it accurately even if `latestRelease` later refreshes to a
      // newer version between download and apply. Update the in-memory cache
      // too — without this, a background update check that publishes a newer
      // release would make `getStagedUpdate()` fall back to the fresher
      // `latestRelease.version` and misreport the version actually on disk.
      this._stagedVersionCache = this.latestRelease.version;
      try {
        await setSetting(
          "stagedPanelUpdateVersion",
          this.latestRelease.version,
        );
      } catch (persistErr) {
        log.debug(`Could not persist staged version: ${persistErr.message}`);
      }

      log.info(
        `Update to v${this.latestRelease.version} staged at ${stagedPath}. Restart to apply.`,
      );
      this.io?.emit("panel:updateReady", {
        version: this.latestRelease.version,
      });

      return {
        success: true,
        message: `Update to v${this.latestRelease.version} downloaded. Restart the panel to apply.`,
        journal: path.basename(journalPath),
      };
    } catch (error) {
      this.lastError = error.message;
      log.error(`Update download failed: ${error.message}`);
      // Clean up any partial on failure
      try {
        if (fs.existsSync(tmpDownloadPath)) fs.unlinkSync(tmpDownloadPath);
      } catch (delErr) {
        log.debug(`Failed to clean partial after error: ${delErr.message}`);
      }
      try {
        if (fs.existsSync(tmpClientArchivePath)) fs.unlinkSync(tmpClientArchivePath);
      } catch (delErr) {
        log.debug(`Failed to clean client archive after error: ${delErr.message}`);
      }
      if (incomingClientPath) {
        fs.rmSync(incomingClientPath, { recursive: true, force: true });
      }
      if (
        fs.existsSync(stagedPath) &&
        !fs.existsSync(path.join(exeDir, "update-bundle.json"))
      ) {
        fs.rmSync(stagedPath, { force: true });
      }
      return { success: false, error: error.message, code: error.code };
    } finally {
      this.isDownloading = false;
    }
  }

  /**
   * Supervisor (Start.bat v2+) hand-off. When the panel was launched by the
   * v2 supervisor batch, we don't run an in-process helper to swap the exe
   * at all — we just drop a marker file next to the exe and exit with code
   * 75. The supervisor sees the marker (or the exit code), renames the
   * staged .new/.new2 over the canonical .exe, then relaunches the panel.
   *
   * This sidesteps every Windows failure mode of the old helper:
   *   - No detached cmd.exe child (Defender / ASR can't kill it mid-flight).
   *   - No taskkill of our own PID (no behavioral signature).
   *   - No `start "" foo.exe.new` (no broken extension association).
   *   - The swap happens BETWEEN runs of the panel, so there's no TIME_WAIT
   *     race on port 3001.
   *   - The supervisor is a plain-text .bat the user already launches —
   *     fully visible, no hidden process, no UNC redirector games.
   *
   * The marker is intentionally a plain JSON sentinel; the .bat only needs
   * to see that it exists. The payload is for human post-mortems and for
   * reconcilePendingUpdate() on the next boot.
   */
  isSupervisorAvailable() {
    return (
      process.platform === "win32" && process.env.PANEL_SUPERVISOR_V === "2"
    );
  }

  writeSupervisorMarker(staged) {
    const exeDir = path.dirname(this.getExeBasePath());
    const markerPath = path.join(exeDir, ".update-pending");
    const payload = {
      version: staged?.version || null,
      stagedFile: staged?.stagedPath ? path.basename(staged.stagedPath) : null,
      journalFile: staged?.journalPath
        ? path.basename(staged.journalPath)
        : "update-bundle.json",
      stagedAt: new Date().toISOString(),
      requestedBy: `panel-pid-${process.pid}`,
    };
    fs.writeFileSync(markerPath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
    });
    log.info(`Wrote supervisor marker: ${markerPath} (v${payload.version})`);
    return markerPath;
  }

  /**
   * Resolve the "base" exe path by stripping any .new/.new2 suffix from
   * process.execPath. After a launch-in-place apply, the running process's
   * execPath is the staged file (e.g. ...\ZomboidControlPanel.exe.new), but
   * callers that want the canonical filename for packaging lookups want the
   * non-suffixed version.
   */
  getExeBasePath() {
    return process.execPath.replace(/\.new2?$/i, "");
  }

  /**
   * Pick a staging slot (.new or .new2) that is NOT the file we're currently
   * running from. Alternates between the two slots so we never try to
   * overwrite our own binary. Windows file locks prevent that anyway, but
   * this gives the apply helper a predictable name to launch.
   */
  getStageSlotPath() {
    const base = this.getExeBasePath();
    const primary = `${base}.new`;
    const secondary = `${base}.new2`;
    const self = path.resolve(process.execPath);
    return path.resolve(primary) === self ? secondary : primary;
  }

  /**
   * Find any staged file on disk (.new or .new2) that is NOT the one we're
   * currently running from. Returns the full path, or null.
   */
  findStagedFileOnDisk() {
    const base = this.getExeBasePath();
    const selfResolved = path.resolve(process.execPath);
    const candidates = [`${base}.new`, `${base}.new2`].filter((p) => {
      try {
        return path.resolve(p) !== selfResolved && fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (!candidates.length) return null;
    // Prefer the newer file if both slots are populated.
    candidates.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
    return candidates[0];
  }

  /**
   * Check if a downloaded-but-not-applied update is staged next to the exe.
   * Returns null if nothing is staged, or { stagedPath, exePath, version }.
   */
  getStagedUpdate() {
    if (typeof process.pkg === "undefined") return null;
    const exePath = process.execPath;
    const journalPath = path.join(
      path.dirname(this.getExeBasePath()),
      "update-bundle.json",
    );
    if (!fs.existsSync(journalPath)) return null;
    let journal;
    try {
      journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    } catch (error) {
      log.warn(`Ignoring invalid update bundle journal: ${error.message}`);
      return null;
    }
    if (journal.phase !== "staged") return null;
    const stagedPath = journal.paths?.stagedBinary;
    if (!stagedPath || !fs.existsSync(journal.paths?.stagedClient || "")) {
      log.warn("Ignoring incomplete staged update bundle");
      return null;
    }
    let size;
    try {
      const stats = fs.statSync(stagedPath);
      size = stats.size;
      if (stats.size < 1024 * 1024) {
        // Sanity: any real build is many MB. Anything smaller is a failed download.
        log.warn(
          `Staged update at ${stagedPath} is suspiciously small (${stats.size} bytes); ignoring.`,
        );
        return null;
      }
    } catch (err) {
      log.debug(`Could not stat staged update: ${err.message}`);
      return null;
    }
    // Prefer the version we recorded at stage time. Fall back to the current
    // latestRelease if we somehow never persisted it (older builds, manual
    // file drops). Reading the setting synchronously from the in-memory DB
    // is fine — this method is called often and must stay non-async.
    let version = journal.version || this._stagedVersionCache || null;
    if (!version) version = this.latestRelease?.version || null;
    return { stagedPath, exePath, version, size, journalPath, journal };
  }

  /**
   * Load the persisted staged-update version into memory. Called at start()
   * so getStagedUpdate() (sync) can surface it without a DB round-trip.
   */
  async loadStagedVersionCache() {
    try {
      this._stagedVersionCache = await getSetting("stagedPanelUpdateVersion");
    } catch (err) {
      log.debug(`Could not load staged version cache: ${err.message}`);
      this._stagedVersionCache = null;
    }
  }


  /**
   * Download a file with progress tracking
   */
  async stageClientDist(archivePath, isWindows, binaryPath, artifactName) {
    const exeDir = path.dirname(process.execPath);
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "zpanel-update-"));
    const escapePowerShellLiteral = (value) => String(value).replace(/'/g, "''");
    let extractArchivePath = archivePath;
    let windowsArchiveCopy = null;

    try {
      if (isWindows) {
        // Expand-Archive rejects a valid ZIP when its staging name lacks a
        // .zip suffix. Keep this defensive copy for callers from older paths.
        if (path.extname(extractArchivePath).toLowerCase() !== ".zip") {
          windowsArchiveCopy = `${extractArchivePath}.zip`;
          fs.copyFileSync(extractArchivePath, windowsArchiveCopy);
          extractArchivePath = windowsArchiveCopy;
        }
        await this.runUpdateCommand("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${escapePowerShellLiteral(extractArchivePath)}' -DestinationPath '${escapePowerShellLiteral(extractDir)}' -Force`,
        ]);
      } else {
        await this.runUpdateCommand("tar", ["-xzf", extractArchivePath, "-C", extractDir]);
      }

      let manifest;
      try {
        manifest = JSON.parse(
          fs.readFileSync(path.join(extractDir, "release-manifest.json"), "utf8"),
        );
      } catch (error) {
        throw new Error(`Release archive manifest is invalid: ${error.message}`);
      }
      const manifestError = validateReleaseManifest(
        manifest,
        this.latestRelease?.version,
        artifactName,
        binaryPath ? (await this.sha256File(binaryPath)).toLowerCase() : null,
      );
      if (manifestError) throw new Error(manifestError);

      const incoming = path.join(extractDir, "client", "dist");
      if (!fs.existsSync(path.join(incoming, "index.html"))) {
        throw new Error("Release archive does not contain client/dist/index.html");
      }
      const metadata = {
        panelVersion: manifest.version,
        buildSha: manifest.buildSha,
        apiContractVersion: manifest.apiContractVersion,
      };
      if (
        !metadata.buildSha ||
        Number(metadata.apiContractVersion) !== 1
      ) {
        throw new Error("Release archive is missing compatible build metadata");
      }
      const clientMetadata = JSON.parse(
        fs.readFileSync(path.join(incoming, "build-info.json"), "utf8"),
      );
      if (
        clientMetadata.panelVersion !== metadata.panelVersion ||
        clientMetadata.buildSha !== metadata.buildSha ||
        Number(clientMetadata.apiContractVersion) !== metadata.apiContractVersion
      ) {
        throw new Error("Release frontend metadata does not match its backend artifact");
      }
      const incomingClientPath = path.join(
        exeDir,
        `.update-client-incoming-${process.pid}`,
      );
      fs.rmSync(incomingClientPath, { recursive: true, force: true });
      fs.cpSync(incoming, incomingClientPath, { recursive: true });
      log.info("Staged verified client bundle without changing live client/dist");

      // Stage the managed launcher/service files too, but do NOT swap them
      // live here. This method only STAGES — the binary and client dist it
      // just prepared above don't become live until applyUpdateBundle()
      // runs (and can still be rolled back after that, until the NEW
      // process acknowledges startup). Swapping start.sh/the unit file
      // eagerly at stage time, as the pre-merge version of this method did,
      // would put them ahead of a binary that might never actually apply,
      // or leave them upgraded after a version-mismatch rollback puts the
      // binary and client back — a half-rollback of exactly the kind
      // restorePreUpdateDataBackup() exists to prevent for the database.
      // Copied into a fixed, deterministic location (not extractDir, which
      // this method's own `finally` below deletes before apply can ever
      // run) so activateStagedLinuxLauncherFiles() can find it later,
      // however long "later" turns out to be.
      if (!isWindows) {
        this.stageLinuxLauncherFiles(extractDir, exeDir);
      }

      return { incomingClientPath, metadata };
    } finally {
      if (windowsArchiveCopy) {
        fs.rmSync(windowsArchiveCopy, { force: true });
      }
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }

  static LINUX_LAUNCHER_FILES = [
    { name: "start.sh", mode: 0o755 },
    { name: "zomboid-panel.service", mode: 0o644 },
    { name: "install-linux-service.sh", mode: 0o755 },
  ];

  // Fixed, deterministic location — not a per-pid or per-transaction name —
  // so activateStagedLinuxLauncherFiles() can find it on a later boot
  // without needing anything threaded through updateBundle.js's journal.
  static getLinuxLauncherStageDir(exeDir) {
    return path.join(exeDir, ".update-linux-files-staged");
  }

  // Called from stageClientDist() at STAGE time, once per download. Copies
  // only — never touches the live start.sh/unit file. See the comment at
  // this method's one call site for why activation is deferred.
  stageLinuxLauncherFiles(extractDir, exeDir) {
    const stageDir = PanelUpdateChecker.getLinuxLauncherStageDir(exeDir);
    for (const file of PanelUpdateChecker.LINUX_LAUNCHER_FILES) {
      if (!fs.existsSync(path.join(extractDir, file.name))) {
        throw new Error(`Release archive does not contain ${file.name}`);
      }
    }
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    for (const file of PanelUpdateChecker.LINUX_LAUNCHER_FILES) {
      fs.copyFileSync(path.join(extractDir, file.name), path.join(stageDir, file.name));
    }
  }

  // Called from server/index.js ONLY after acknowledgeUpdateBundle() has
  // confirmed the new binary/client are good and deleted their own journal
  // — the one point in the whole update lifecycle where a rollback of the
  // binary/client can no longer happen, so swapping these files here can
  // never land ahead of a binary that gets rolled back later. Best-effort:
  // a failure here does not undo the (already-committed) binary/client
  // update, it just leaves the old launcher/unit in place for this cycle —
  // logged clearly, with the same remediation command getRestartAssessment()
  // already gives an operator for exactly this state.
  activateStagedLinuxLauncherFiles(exeDir) {
    const stageDir = PanelUpdateChecker.getLinuxLauncherStageDir(exeDir);
    if (!fs.existsSync(stageDir)) return false;

    const swapped = [];
    try {
      for (const file of PanelUpdateChecker.LINUX_LAUNCHER_FILES) {
        const source = path.join(stageDir, file.name);
        const target = path.join(exeDir, file.name);
        const staged = `${target}.new`;
        const backup = `${target}.previous`;
        fs.rmSync(staged, { force: true });
        fs.rmSync(backup, { force: true });
        fs.copyFileSync(source, staged);
        fs.chmodSync(staged, file.mode);
        if (fs.existsSync(target)) fs.renameSync(target, backup);
        try {
          fs.renameSync(staged, target);
        } catch (error) {
          if (fs.existsSync(backup) && !fs.existsSync(target)) {
            fs.renameSync(backup, target);
          }
          throw error;
        }
        swapped.push({ target, backup });
      }
    } catch (error) {
      for (const { target, backup } of swapped.reverse()) {
        try {
          fs.rmSync(target, { force: true });
          if (fs.existsSync(backup)) fs.renameSync(backup, target);
        } catch (rollbackError) {
          log.error(`Could not roll back ${target}: ${rollbackError.message}`);
        }
      }
      throw error;
    }
    for (const { backup } of swapped) fs.rmSync(backup, { force: true });
    fs.rmSync(stageDir, { recursive: true, force: true });
    log.info("Updated Linux launcher and service templates from verified release archive");
    return true;
  }

  runUpdateCommand(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
      });
    });
  }

  downloadFile(url, destPath, expectedSize, expectedKind = "binary") {
    return new Promise((resolve, reject) => {
      let settled = false;
      // Assigned once the response arrives and the write stream is opened;
      // referenced here (outer scope) so fail() -- reachable from a
      // timeout/abort that fires mid-download, before or after that point --
      // can actually close it.
      let file = null;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        // On a timeout/abort partway through, the piped write stream was
        // never told the source died -- pipe() only auto-ends a destination
        // on a normal source end, never on a source error -- so it stayed
        // open, holding the file descriptor. Deleting the file first and
        // leaving the stream running left destPath potentially still
        // writable by an orphaned handle, and on Windows an unlink against
        // a still-open handle can silently fail (the callback below
        // swallows the error), leaving the corrupt partial download on disk
        // for a later attempt to trip over. Destroy the stream and wait for
        // its own close before unlinking, so the delete has an actual
        // chance to succeed.
        if (file && !file.destroyed) {
          file.once("close", () => fs.unlink(destPath, () => {}));
          file.destroy();
        } else {
          fs.unlink(destPath, () => {});
        }
        reject(error);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const isAllowedRedirectHost = (downloadUrl) => {
        try {
          const parsed = new URL(downloadUrl);
          const host = parsed.hostname.toLowerCase();
          return (
            host === "github.com" ||
            host === "api.github.com" ||
            host === "objects.githubusercontent.com" ||
            host === "github-releases.githubusercontent.com" ||
            host.endsWith(".githubusercontent.com")
          );
        } catch (e) {
          log.debug(`Invalid download URL: ${e.message}`);
          return false;
        }
      };

      const follow = (downloadUrl, redirectCount = 0) => {
        if (redirectCount > MAX_DOWNLOAD_REDIRECTS) {
          return fail(
            new Error(`Too many redirects (max ${MAX_DOWNLOAD_REDIRECTS})`),
          );
        }

        if (!downloadUrl.startsWith("https://")) {
          return fail(new Error("Download URL must use HTTPS"));
        }

        if (!isAllowedRedirectHost(downloadUrl)) {
          return fail(new Error("Download host is not trusted"));
        }

        const req = https.get(
          downloadUrl,
          {
            headers: {
              "User-Agent": `ZomboidControlPanel/${this.currentVersion}`,
            },
          },
          (res) => {
            // Follow redirects (GitHub uses them for asset downloads)
            if (
              res.statusCode === 301 ||
              res.statusCode === 302 ||
              res.statusCode === 307 ||
              res.statusCode === 308
            ) {
              const location = res.headers.location;
              if (!location)
                return fail(new Error("Redirect without location"));
              if (!location.startsWith("https://"))
                return fail(new Error("Redirect to non-HTTPS URL rejected"));
              res.resume();
              follow(location, redirectCount + 1);
              return;
            }

            if (res.statusCode !== 200) {
              res.resume();
              return fail(new Error(`Download failed: HTTP ${res.statusCode}`));
            }

            const totalBytes = parseInt(
              res.headers["content-length"] || expectedSize,
              10,
            );
            let receivedBytes = 0;
            file = fs.createWriteStream(destPath);

            let lastEmittedProgress = -1;
            res.on("data", (chunk) => {
              receivedBytes += chunk.length;
              if (totalBytes > 0) {
                this.downloadProgress = Math.round(
                  (receivedBytes / totalBytes) * 100,
                );
                // Throttle progress updates to every 5% increment
                const bucket = Math.floor(this.downloadProgress / 5) * 5;
                if (bucket > lastEmittedProgress) {
                  lastEmittedProgress = bucket;
                  this.io?.emit("panel:downloadProgress", {
                    progress: this.downloadProgress,
                    status: "downloading",
                    received: receivedBytes,
                    total: totalBytes,
                  });
                }
              }
            });

            res.on("error", fail);
            res.pipe(file);
            file.on("finish", () => {
              file.close(() => {
                if (expectedSize > 0 && receivedBytes !== expectedSize) {
                  return fail(
                    new Error(
                      `Downloaded file size mismatch (expected ${expectedSize}, got ${receivedBytes})`,
                    ),
                  );
                }
                // Reject HTML/JSON error pages and partially-written blobs.
                // Standalone updates download both an executable and the
                // matching client archive, which have different signatures.
                const magicErr =
                  expectedKind === "archive"
                    ? this.validateArchiveMagic(destPath)
                    : this.validateBinaryMagic(destPath);
                if (magicErr) {
                  return fail(
                    new Error(
                      `Downloaded file failed integrity check: ${magicErr}`,
                    ),
                  );
                }
                succeed();
              });
            });
            file.on("error", (err) => {
              fail(err);
            });
          },
        );

        req.on("error", fail);
        req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
          const timeoutError = new Error("Download timed out");
          timeoutError.code = "ETIMEDOUT";
          req.destroy(timeoutError);
        });
      };

      follow(url);
    });
  }

  /**
   * Get current status
   */
  getStatus() {
    const staged = this.getStagedUpdate();
    // Drop stale apply results: if a previous "success" was recorded for a
    // version we are no longer running, it's no longer relevant.
    let lastApplyResult = this.lastApplyResult || null;
    if (
      lastApplyResult &&
      lastApplyResult.status === "success" &&
      lastApplyResult.appliedVersion &&
      this.currentVersion &&
      lastApplyResult.appliedVersion !== this.currentVersion
    ) {
      lastApplyResult = null;
    }
    return {
      currentVersion: this.currentVersion,
      updateAvailable: this.updateAvailable,
      latestVersion: this.latestRelease?.version || null,
      releaseUrl: this.latestRelease?.htmlUrl || null,
      releaseNotes: this.latestRelease?.body || null,
      publishedAt: this.latestRelease?.publishedAt || null,
      isChecking: this.isChecking,
      isDownloading: this.isDownloading,
      downloadProgress: this.downloadProgress,
      lastCheck: this.lastCheck,
      lastError: this.lastError,
      updateMode: this.dockerUpdateProxy.mode,
      stagedUpdate: staged
        ? { version: staged.version, path: staged.stagedPath }
        : null,
      lastApplyResult,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hardening: preflight, validation, post-apply confirmation, log surfacing
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run preflight checks before download/apply. Returns:
  *   { ok, blockers: string[], warnings: string[], blockerDetails: [], warningDetails: [], info: {...} }
   * Blockers prevent the update from proceeding; warnings are shown to the user.
   */
  async preflight() {
    const blockers = [];
    const warnings = [];
    const blockerDetails = [];
    const warningDetails = [];
    const info = {};

    const isWindows = process.platform === "win32";
    const isPackaged = typeof process.pkg !== "undefined";
    info.isPackaged = isPackaged;
    info.platform = process.platform;
    info.updateMode = this.dockerUpdateProxy.mode;
    info.restartAssessment = getRestartAssessment();
    info.temporaryDirectory = os.tmpdir();
    info.applyLogPath = path.join(getDataPaths().logsDir, "panel-update-last.log");

    if (this.dockerUpdateProxy.enabled) {
      info.dockerUpdater = true;
      // Docker mode performs these checks in the separate update controller.
      // Report that explicitly instead of returning an empty, misleading
      // warning list.
      info.checksPerformed = false;
      info.dockerNotChecked = {
        key: "updates.preflight.dockerNotChecked",
        params: {},
        message:
          "Docker updates are applied by a separate update controller container. The panel does not run its own preflight checks (disk space, permissions, etc.) for this mode -- those are the controller's responsibility.",
      };
      return { ok: true, blockers, warnings, blockerDetails, warningDetails, info };
    }

    if (!isPackaged) {
      const containerized = isContainerized();
      addPreflightMessage(
        blockers,
        blockerDetails,
        containerized
          ? "updates.preflight.packagedBuildDocker"
          : "updates.preflight.packagedBuildGit",
        {},
        `Self-update is only available in packaged builds. ${getDevModeUpgradeInstruction(containerized)}`,
      );
      return { ok: false, blockers, warnings, blockerDetails, warningDetails, info };
    }

    if (!this.latestRelease) {
      addPreflightMessage(
        warnings,
        warningDetails,
        "updates.preflight.noReleaseInfo",
        {},
        "No release info cached yet — click Check for Updates first.",
      );
      return { ok: blockers.length === 0, blockers, warnings, blockerDetails, warningDetails, info };
    }

    if (!this.updateAvailable) {
      info.alreadyCurrent = true;
    }

    const exePath = process.execPath;
    const exeDir = path.dirname(exePath);
    info.exePath = exePath;
    info.exeDir = exeDir;

    // Keep the update tied to the data directory the running panel actually
    // uses. A resumed Windows update must not silently become a fresh install.
    const dataPaths = getDataPaths();
    info.dataDir = dataPaths.dataDir;
    info.dbPath = dataPaths.dbPath;
    if (fs.existsSync(dataPaths.dbPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(dataPaths.dbPath, "utf8"));
        info.databaseUsers = Array.isArray(parsed.users) ? parsed.users.length : 0;
        info.databaseServers = Array.isArray(parsed.servers) ? parsed.servers.length : 0;
        info.databaseReadable = true;
      } catch (err) {
        info.databaseReadable = false;
        addPreflightMessage(
          blockers,
          blockerDetails,
          "updates.preflight.databaseUnreadable",
          { error: err.message },
          `Panel database cannot be read before update: ${err.message}.`,
        );
      }
    } else {
      info.databaseReadable = false;
      addPreflightMessage(
        warnings,
        warningDetails,
        "updates.preflight.databaseMissing",
        {},
        "No data/db.json was found beside the running panel. This looks like a fresh install; verify the data folder before applying the update.",
      );
    }

    // Resolve the asset so we can size-check.
    const assetName = isWindows
      ? "ZomboidControlPanel.exe"
      : "ZomboidControlPanel";
    const isArchive = (name) => /\.(zip|tar\.gz|tgz|7z|rar)$/i.test(name || "");
    let asset = this.latestRelease.assets.find((a) => a.name === assetName);
    if (!asset) {
      if (isWindows) {
        asset = this.latestRelease.assets.find(
          (a) => /\.exe$/i.test(a.name) && !isArchive(a.name),
        );
      } else {
        asset = this.latestRelease.assets.find(
          (a) =>
            !isArchive(a.name) &&
            !/\.exe$/i.test(a.name) &&
            a.name.toLowerCase().includes("linux"),
        );
      }
    }
    if (!asset) {
      const platform = isWindows ? "Windows" : "Linux";
      addPreflightMessage(
        blockers,
        blockerDetails,
        "updates.preflight.binaryMissing",
        { platform },
        `No ${isWindows ? "Windows" : "Linux"} binary found in the latest release.`,
      );
    } else {
      info.asset = { name: asset.name, size: asset.size };
    }

    // Write permission probe — try to create + remove a test file next to the exe.
    const probePath = path.join(exeDir, `.panel-write-probe.${process.pid}`);
    let probeCreated = false;
    try {
      fs.writeFileSync(probePath, "ok");
      probeCreated = true;
      info.writable = true;
    } catch (err) {
      info.writable = false;
      const permissionKey =
        process.platform === "win32"
          ? "updates.preflight.folderNotWritableWindows"
          : process.platform === "linux"
            ? "updates.preflight.folderNotWritableLinux"
            : "updates.preflight.folderNotWritableOther";
      addPreflightMessage(
        blockers,
        blockerDetails,
        permissionKey,
        { detail: err.code || err.message },
        getPanelFolderPermissionGuidance(process.platform, err.code || err.message),
      );
    } finally {
      if (probeCreated) {
        try {
          fs.unlinkSync(probePath);
        } catch (unlinkErr) {
          log.debug(
            `Could not remove write probe ${probePath}: ${unlinkErr.message}`,
          );
        }
      }
    }

    // Need roughly 2x the asset size for staging and replacement. An unknown
    // free-space result is a warning, not a successful check.
    if (asset?.size) {
      try {
        const free = await this.getFreeDiskSpace(exeDir);
        info.freeBytes = free;
        const needed = asset.size * 2;
        if (free === null) {
          addPreflightMessage(
            warnings,
            warningDetails,
            "updates.preflight.diskSpaceUnknown",
            {},
            "Could not determine free disk space before update. Proceeding without this check — verify you have enough free space manually if the apply fails partway through.",
          );
        } else if (free < needed) {
          const neededMb = (needed / 1024 / 1024).toFixed(0);
          const freeMb = (free / 1024 / 1024).toFixed(0);
          addPreflightMessage(
            blockers,
            blockerDetails,
            "updates.preflight.diskSpace",
            { neededMb, freeMb },
            `Not enough free disk space. Need ~${(needed / 1024 / 1024).toFixed(0)} MB, have ${(free / 1024 / 1024).toFixed(0)} MB.`,
          );
        }
      } catch (err) {
        info.freeBytes = null;
        addPreflightMessage(
          warnings,
          warningDetails,
          "updates.preflight.diskSpaceUnknown",
          {},
          "Could not determine free disk space before update. Proceeding without this check — verify you have enough free space manually if the apply fails partway through.",
        );
        log.debug(`Free-space check failed: ${err.message}`);
      }
    }

    // OneDrive/sync warning — this is the exact failure from the bug report.
    if (isWindows) {
      const lowered = exeDir.toLowerCase();
      const inOneDrive =
        lowered.includes("\\onedrive\\") || lowered.includes("\\onedrive -");
      const onDesktop = /\\desktop(\\|$)/.test(lowered);
      const inDocuments = /\\documents(\\|$)/.test(lowered);
      if (inOneDrive) {
        addPreflightMessage(
          warnings,
          warningDetails,
          "updates.preflight.oneDrive",
          {},
          "Panel lives inside a OneDrive-synced folder. Sync can briefly lock the exe while it is being replaced. Pause OneDrive before clicking Restart and Apply, or move the panel to a non-synced location (e.g. C:\\ZomboidPanel).",
        );
        info.oneDrive = true;
      } else if (onDesktop || inDocuments) {
        addPreflightMessage(
          warnings,
          warningDetails,
          "updates.preflight.syncSuspect",
          {},
          "Panel lives on the Desktop or in Documents. If you use OneDrive Backup/Known Folder Move, that folder is sync-backed and may lock the exe during apply. Consider moving the panel to a non-synced location.",
        );
        info.syncSuspect = true;
      }

      const inProgramFiles = /^c:\\program files/i.test(exeDir);
      if (inProgramFiles) {
        addPreflightMessage(
          warnings,
          warningDetails,
          "updates.preflight.programFiles",
          {},
          "Panel is installed under Program Files — Windows requires Administrator rights to replace files there. If apply fails, relaunch the panel as Administrator.",
        );
        info.programFiles = true;
      }
    }

    // Existing staged file?
    const staged = this.getStagedUpdate();
    if (staged) {
      info.stagedUpdate = { version: staged.version, path: staged.stagedPath };
      addPreflightMessage(
        warnings,
        warningDetails,
        "updates.preflight.previousUpdateStaged",
        { version: staged.version || "?" },
        `A previous update (v${staged.version || "?"}) is already staged and ready to apply on next restart.`,
      );
    }

    // Lingering backup from a prior apply. The bundle-journal rewrite
    // renamed this suffix from ".old" to ".bundle-previous" (see
    // updateBundle.js's backupBinaryPath and build.js's BIN_BACKUP), but
    // this probe was never updated to match -- it has been checking a
    // filename nothing writes anymore since that rewrite landed, so it can
    // never fire for the current mechanism. That silence reads as "nothing
    // lingering" when the actual current risk (a .bundle-previous a failed
    // or incomplete rollback left behind -- exactly the class of bug fixed
    // in acb202b1) goes completely unchecked here. Checking both: the
    // current suffix as the real signal, the legacy one only so a
    // long-unapplied pre-rewrite install still gets a warning too.
    try {
      const bundlePreviousPath = `${exePath}.bundle-previous`;
      const legacyOldPath = `${exePath}.old`;
      const lingeringPath = fs.existsSync(bundlePreviousPath)
        ? bundlePreviousPath
        : fs.existsSync(legacyOldPath)
          ? legacyOldPath
          : null;
      if (lingeringPath) {
        info.oldPath = lingeringPath;
        addPreflightMessage(
          warnings,
          warningDetails,
          "updates.preflight.previousBackup",
          {},
          "A previous backup is present next to the exe. It will be cleaned up on the next successful apply.",
        );
      }
    } catch (err) {
      log.debug(`Previous-backup probe failed: ${err.message}`);
    }

    return { ok: blockers.length === 0, blockers, warnings, blockerDetails, warningDetails, info };
  }

  /**
   * Best-effort free-disk-space probe. Returns bytes, or null on failure.
   * Uses a statfs API where available; falls back to null rather than throw.
   */
  async getFreeDiskSpace(dirPath) {
    try {
      if (typeof fs.promises.statfs === "function") {
        const stat = await fs.promises.statfs(dirPath);
        return Number(stat.bavail) * Number(stat.bsize);
      }
    } catch (err) {
      log.debug(`statfs failed: ${err.message}`);
    }
    return null;
  }

  /**
   * Validate that a downloaded file is actually a binary for the current platform.
   * Returns null if valid, or an error message describing the mismatch.
   */
  validateBinaryMagic(filePath) {
    try {
      const fd = fs.openSync(filePath, "r");
      const header = Buffer.alloc(4);
      let bytesRead;
      try {
        bytesRead = fs.readSync(fd, header, 0, 4, 0);
      } finally {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
      if (bytesRead < 2) return "file is shorter than a file header";

      if (process.platform === "win32") {
        // PE/EXE: starts with 'MZ' (0x4D 0x5A).
        if (header[0] !== 0x4d || header[1] !== 0x5a) {
          return `not a Windows executable (expected MZ header, got 0x${header[0].toString(16)}${header[1].toString(16)})`;
        }
      } else {
        // ELF: 0x7F 'E' 'L' 'F'.
        if (
          bytesRead < 4 ||
          header[0] !== 0x7f ||
          header[1] !== 0x45 ||
          header[2] !== 0x4c ||
          header[3] !== 0x46
        ) {
          return "not a Linux ELF executable";
        }
      }
      return null;
    } catch (err) {
      return `could not read downloaded file: ${err.message}`;
    }
  }

  /** Validate the ZIP (Windows) or gzip (Linux) release package signature. */
  validateArchiveMagic(filePath) {
    try {
      const header = fs.readFileSync(filePath, { encoding: null }).subarray(0, 4);
      if (header.length < 2) return "file is shorter than an archive header";

      if (process.platform === "win32") {
        // ZIP: PK followed by a local header, empty archive, or data descriptor.
        if (
          header[0] !== 0x50 ||
          header[1] !== 0x4b ||
          ![0x03, 0x05, 0x07].includes(header[2])
        ) {
          return "not a ZIP archive";
        }
      } else if (header[0] !== 0x1f || header[1] !== 0x8b) {
        return "not a gzip archive";
      }
      return null;
    } catch (err) {
      return `could not read downloaded archive: ${err.message}`;
    }
  }

  /**
   * Compute the SHA256 digest of a file as a lowercase hex string.
   */
  sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  /**
   * Fetch a small text asset (e.g. checksums.txt) to memory. Enforces the same
   * host allow-list and redirect cap as downloadFile, and caps the body at
   * 64KB so a compromised mirror can't pin memory.
   */
  fetchReleaseText(url, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
      const allowedHost = (u) => {
        try {
          const host = new URL(u).hostname.toLowerCase();
          return (
            host === "github.com" ||
            host === "api.github.com" ||
            host === "objects.githubusercontent.com" ||
            host === "github-releases.githubusercontent.com" ||
            host.endsWith(".githubusercontent.com")
          );
        } catch {
          return false;
        }
      };

      const follow = (u, hops) => {
        if (hops > MAX_DOWNLOAD_REDIRECTS)
          return reject(new Error("Too many redirects"));
        if (!u.startsWith("https://"))
          return reject(new Error("Non-HTTPS URL rejected"));
        if (!allowedHost(u)) return reject(new Error("Untrusted host"));

        const req = https.get(
          u,
          {
            headers: {
              "User-Agent": `ZomboidControlPanel/${this.currentVersion}`,
            },
          },
          (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode)) {
              const loc = res.headers.location;
              res.resume();
              if (!loc) return reject(new Error("Redirect without location"));
              return follow(loc, hops + 1);
            }
            if (res.statusCode !== 200) {
              res.resume();
              return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let size = 0;
            const chunks = [];
            res.on("data", (chunk) => {
              size += chunk.length;
              if (size > maxBytes) {
                res.destroy(new Error(`Response exceeds ${maxBytes} bytes`));
                return;
              }
              chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () =>
              resolve(Buffer.concat(chunks).toString("utf8")),
            );
          },
        );
        req.on("error", reject);
        req.setTimeout(GITHUB_API_TIMEOUT_MS, () =>
          req.destroy(new Error("Timed out")),
        );
      };

      follow(url, 0);
    });
  }

  /**
   * Verify a downloaded file against checksums.txt from the release.
   * Returns:
   *   true  = checksum present and matched
   *   false = checksum present and did NOT match (throwable by caller)
   *   null  = checksum file not published in this release (skip w/ warning)
   *
   * Throws if checksums.txt IS published but cannot be fetched. Silently
   * skipping on fetch failure would let a network-level attacker disable
   * verification just by blocking one request.
   */
  async verifyChecksum(filePath, assetName) {
    if (!this.latestRelease?.assets) return null;
    const checksumAsset = this.latestRelease.assets.find(
      (a) => a.name === "checksums.txt",
    );
    if (!checksumAsset) return null;

    let text;
    try {
      text = await this.fetchReleaseText(checksumAsset.downloadUrl);
    } catch (err) {
      throw new Error(
        `Release publishes checksums.txt but it could not be fetched: ${err.message}`,
      );
    }

    // Format: `<hex>  <filename>` per line. Tolerate extra whitespace and
    // comments. We only compare to the entry for our exact asset.
    const want = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const m = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/);
        return m ? { hash: m[1].toLowerCase(), name: m[2] } : null;
      })
      .filter(Boolean)
      .find((entry) => entry.name === assetName);

    if (!want) {
      log.warn(`checksums.txt present but has no entry for ${assetName}`);
      return null;
    }

    const got = (await this.sha256File(filePath)).toLowerCase();
    if (got !== want.hash) {
      log.error(
        `SHA256 mismatch for ${assetName}: expected ${want.hash}, got ${got}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Reconcile a pending update recorded before the last restart.
   * - If currentVersion matches the pending one → success (emit + clear).
   * - If staged file is still present → apply failed; capture helper log.
   * - Otherwise → apply may have silently failed or was never run.
   */
  async reconcilePendingUpdate() {
    const pending = await getSetting("pendingPanelUpdate");
    if (!pending) return;

    log.info(
      `Reconciling pending panel update: was v${pending}, now v${this.currentVersion}`,
    );

    // Happy path: we are running EXACTLY the pending version. We deliberately
    // do NOT accept "newer than pending" as success — that can happen when a
    // user manually recovers from a failed apply by dropping a later build on
    // disk, and we'd rather surface that as still-failed than silently green.
    if (this.currentVersion === pending) {
      this.lastApplyResult = {
        status: "success",
        appliedVersion: pending,
        at: new Date().toISOString(),
      };
      await setSetting("pendingPanelUpdate", null);
      await setSetting("stagedPanelUpdateVersion", null);
      this._stagedVersionCache = null;
      log.info(`Panel update applied successfully → v${this.currentVersion}`);
      this.io?.emit("panel:updateApplied", this.lastApplyResult);
      return;
    }

    // Apply failed. Gather as much context as we can for the UI.
    const helperLog = this.readMostRecentApplyLog();
    const staged = this.getStagedUpdate();
    const stagedStillPresent = Boolean(staged);

    // A manual installation can move the panel past an older pending marker
    // while also removing the old staged binary. There is then nothing left
    // to retry, and keeping the marker turns a successful recovery into a
    // permanent false failure banner on every startup.
    if (!stagedStillPresent && this.isNewer(this.currentVersion, pending)) {
      await setSetting("pendingPanelUpdate", null);
      await setSetting("stagedPanelUpdateVersion", null);
      this._stagedVersionCache = null;
      this.lastApplyResult = null;
      log.info(
        `Cleared superseded pending panel update: running v${this.currentVersion}, pending v${pending}`,
      );
      return;
    }

    // Heuristic: the helper ran, reported "Update applied", and then the exe
    // vanished or the relaunch failed "cannot find the file specified". That
    // is the AV / Controlled Folder Access signature. Surface it as a hint so
    // the UI can show recovery guidance without the user having to read logs.
    const likelyCause = this.classifyApplyFailure(
      helperLog,
      stagedStillPresent,
    );

    this.lastApplyResult = {
      status: "failed",
      pendingVersion: pending,
      currentVersion: this.currentVersion,
      at: new Date().toISOString(),
      stagedStillPresent,
      helperLog,
      likelyCause,
      // Only meaningful when likelyCause is "rollback_failed" -- see
      // isRollbackRetryLikely()'s own doc comment. Omitted for every other
      // cause rather than always including an irrelevant false.
      ...(likelyCause === "rollback_failed"
        ? { rollbackRetryLikely: this.isRollbackRetryLikely(helperLog) }
        : {}),
      // Tell the UI whether "click Restart to retry" will work. If the staged
      // file is gone, the user has to re-download first.
      canRetryApply: stagedStillPresent,
      panelFolder: path.dirname(process.execPath),
    };
    log.warn(
      `Panel update apply appears to have failed (pending v${pending}, running v${this.currentVersion}, cause: ${likelyCause})`,
    );
    this.io?.emit("panel:updateApplyFailed", this.lastApplyResult);

    // Don't clear pendingPanelUpdate — keep it so the user can retry apply
    // when the staged file is still on disk. If it isn't, the next successful
    // download will overwrite the pending marker at restart time.
  }

  /**
   * Look at the apply log and disk state and guess why apply failed. Used
   * purely to help the UI render a useful hint. Never throws.
   *   'helper_blocked' — helper script was blocked from even starting (ASR)
   *   'av_quarantine' — placed file vanished / relaunch couldn't find it
   *   'rename_locked' — could not rename the running exe (file in use)
   *   'permission'    — access denied on move/copy
   *   'no_helper_log' — no log found at all
   *   'unknown'       — log exists but doesn't match a known pattern
   *
   * Order matters: check permission before lock, and check AV signatures
   * first because "cannot find path" / "system cannot find the file" can
   * appear inside a failed Move-Item message where the real cause is AV
   * having deleted the source between operations, not a plain file-lock.
   */
  classifyApplyFailure(helperLog, stagedStillPresent) {
    if (!helperLog) return "no_helper_log";
    const l = helperLog.toLowerCase();

    // Supervisor v2 writes bracketed failure codes. Prefer the last code in
    // the log, then fall back to legacy prose for upgraded installations.
    const supervisorTags = [
      ...helperLog.matchAll(
        /\[(av_quarantine|version_mismatch|startup_handshake_failed|frontend_swap_failed|binary_swap_failed|bundle_apply_failed|rollback_failed)\]/gi,
      ),
    ].map((m) => m[1].toLowerCase());
    const lastSupervisorTag = supervisorTags[supervisorTags.length - 1];
    if (lastSupervisorTag === "av_quarantine") return "av_quarantine";
    if (lastSupervisorTag === "binary_swap_failed") return "rename_locked";
    if (lastSupervisorTag === "rollback_failed") return "rollback_failed";

    // Legacy helper was blocked before it could start (ASR, AV, or policy).
    if (l.includes("[pre-spawn]") && !l.includes("apply helper started")) {
      return "helper_blocked";
    }

    // Legacy AV / Controlled Folder Access wording: the staged file vanished
    // between helper steps.
    // Patterns cover: post-place verify failure, rollback copy wiped, staged
    // gone before we started, and the Windows "cannot find" messages that
    // surface as Move-Item failures when the source was deleted mid-apply.
    if (
      l.includes("quarantined by av") ||
      l.includes("disappeared or is empty") ||
      l.includes("controlled folder access") ||
      l.includes("cannot find the file specified") ||
      l.includes("cannot find path") ||
      l.includes("staged path is already missing") ||
      l.includes("backup .old is also missing") ||
      l.includes("rollback did not stick") ||
      l.includes("rollback copy failed")
    ) {
      return "av_quarantine";
    }

    // Permission: check BEFORE rename-lock because "access is denied" on a
    // rename attempt is a permission problem, not a transient file lock.
    if (
      l.includes("access is denied") ||
      l.includes("access denied") ||
      l.includes("unauthorized")
    ) {
      return "permission";
    }

    // File locked by another process — either the rename (exe → .old) or the
    // place (.new → exe) was blocked by AV scan, OneDrive sync, or another
    // holder of the exe handle.
    if (
      l.includes("could not rename running exe") ||
      l.includes("rename attempt") ||
      l.includes("place attempt") ||
      l.includes("being used by another process") ||
      l.includes("it is being used by")
    ) {
      // If rename failed AND there is no staged file left on disk, AV most
      // likely deleted .new between download and apply — treat as quarantine
      // so the UI surfaces the exclusion hint instead of a generic lock msg.
      if (
        !stagedStillPresent &&
        (l.includes("rename attempt") ||
          l.includes("could not rename running exe"))
      ) {
        return "av_quarantine";
      }
      return "rename_locked";
    }

    return "unknown";
  }

  /**
   * Whether a rollback failure will recur automatically on the next restart.
   *
   * Never throws.
   *
   * The final "could not remove journal" line means the swap recovered and
   * only the journal cleanup failed. That case is not retryable.
   *
   * Checks the LAST rollback_failed-tagged line specifically (not just
   * whether the tag appears anywhere), for the same reason
   * classifyApplyFailure() does: build.js always stamps its "rollback
   * incomplete" summary line last whenever the restore itself failed, so an
   * earlier, different rollback_failed line earlier in the same log must
   * not override the line that actually ended the run.
   */
  isRollbackRetryLikely(helperLog) {
    if (!helperLog) return false;
    const rollbackLines = helperLog
      .split(/\r?\n/)
      .filter((line) => /\[rollback_failed\]/i.test(line));
    if (rollbackLines.length === 0) return false;
    const last = rollbackLines[rollbackLines.length - 1].toLowerCase();
    return !last.includes("could not remove journal");
  }

  /**
   * Read the most recent Windows apply-helper log from TEMP, if any.
   * Returns up to 8KB of log text or null.
   */
  readMostRecentApplyLog() {
    // Current releases write supervisor.log. Keep the older logs-directory
    // fallbacks for upgraded installations, but never read predictable files
    // from the shared system temp directory.
    try {
      const logsDir = getDataPaths().logsDir;
      const supervisor = path.join(logsDir, "supervisor.log");
      if (fs.existsSync(supervisor)) {
        const stat = fs.statSync(supervisor);
        const MAX_BYTES = 8 * 1024;
        if (stat.size <= MAX_BYTES) {
          const content = fs.readFileSync(supervisor, "utf8");
          if (content.trim()) return content;
        } else {
          const fd = fs.openSync(supervisor, "r");
          try {
            const buf = Buffer.alloc(MAX_BYTES);
            fs.readSync(fd, buf, 0, MAX_BYTES, stat.size - MAX_BYTES);
            return `... (truncated, tail only)\n${buf.toString("utf8")}`;
          } finally {
            fs.closeSync(fd);
          }
        }
      }
      const stable = path.join(logsDir, "panel-update-last.log");
      if (fs.existsSync(stable)) {
        const stat = fs.statSync(stable);
        const MAX_BYTES = 8 * 1024;
        if (stat.size <= MAX_BYTES) {
          const content = fs.readFileSync(stable, "utf8");
          if (content.trim()) return content;
        } else {
          const fd = fs.openSync(stable, "r");
          try {
            const buf = Buffer.alloc(MAX_BYTES);
            fs.readSync(fd, buf, 0, MAX_BYTES, stat.size - MAX_BYTES);
            return `... (truncated, tail only)\n${buf.toString("utf8")}`;
          } finally {
            fs.closeSync(fd);
          }
        }
      }
    } catch (err) {
      log.debug(`readMostRecentApplyLog (stable) failed: ${err.message}`);
    }
    try {
      const dir = getDataPaths().logsDir;
      const names = fs
        .readdirSync(dir)
        .filter((n) => /^panel-update-\d+\.log$/.test(n))
        .map((n) => {
          const fp = path.join(dir, n);
          try {
            const stat = fs.statSync(fp);
            return { fp, mtime: stat.mtimeMs, size: stat.size };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
      if (names.length) {
        const { fp, size } = names[0];
        const MAX_BYTES = 8 * 1024;
        if (size <= MAX_BYTES) return fs.readFileSync(fp, "utf8");
        const fd = fs.openSync(fp, "r");
        try {
          const buf = Buffer.alloc(MAX_BYTES);
          fs.readSync(fd, buf, 0, MAX_BYTES, size - MAX_BYTES);
          return `... (truncated, tail only)\n${buf.toString("utf8")}`;
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (err) {
      log.debug(`readMostRecentApplyLog (logs dir) failed: ${err.message}`);
    }
    return null;
  }

  /**
   * Remove artifacts left by current and legacy apply flows. Prune:
   *   - .ps1 files in %TEMP% (legacy, pre-v1.0.21)
   *   - .cmd files in <exeDir>/.panel-helpers/ (v1.0.21+)
   *   - timestamped .log files in logsDir
   *
   * Keep the most recent `keep` of each so post-mortem debugging still works.
   */
  cleanupOldHelperArtifacts(keep = 5) {
    const tmpDir = os.tmpdir();
    const tmpPatterns = [
      /^zomboid-panel-update-\d+\.log$/,
      /^zomboid-panel-apply-\d+-\d+\.ps1$/,
    ];
    let tmpEntries;
    try {
      tmpEntries = fs.readdirSync(tmpDir);
    } catch (err) {
      log.debug(`Could not read TEMP dir: ${err.message}`);
      tmpEntries = [];
    }
    for (const pattern of tmpPatterns) {
      const matching = tmpEntries
        .filter((n) => pattern.test(n))
        .map((n) => {
          const fp = path.join(tmpDir, n);
          try {
            return { fp, mtime: fs.statSync(fp).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
      const toDelete = matching.slice(keep);
      for (const { fp } of toDelete) {
        try {
          fs.unlinkSync(fp);
        } catch (err) {
          log.debug(
            `Could not remove old helper artifact ${fp}: ${err.message}`,
          );
        }
      }
    }

    // Prune .cmd helpers in <exeDir>/.panel-helpers/ (v1.0.21+)
    try {
      const helperDir = path.join(
        path.dirname(process.execPath),
        ".panel-helpers",
      );
      if (fs.existsSync(helperDir)) {
        const cmdPattern = /^apply-update-\d+\.cmd$/;
        const cmdEntries = fs
          .readdirSync(helperDir)
          .filter((n) => cmdPattern.test(n))
          .map((n) => {
            const fp = path.join(helperDir, n);
            try {
              return { fp, mtime: fs.statSync(fp).mtimeMs };
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime);
        const toDelete = cmdEntries.slice(keep);
        for (const { fp } of toDelete) {
          try {
            fs.unlinkSync(fp);
          } catch (err) {
            log.debug(`Could not remove old helper cmd ${fp}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      log.debug(`Could not prune helper dir: ${err.message}`);
    }

    // Also prune timestamped logs in the panel's logs dir (keep the stable
    // panel-update-last.log forever).
    try {
      const logsDir = getDataPaths().logsDir;
      const logPattern = /^panel-update-\d+\.log$/;
      const logEntries = fs
        .readdirSync(logsDir)
        .filter((n) => logPattern.test(n))
        .map((n) => {
          const fp = path.join(logsDir, n);
          try {
            return { fp, mtime: fs.statSync(fp).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
      const toDelete = logEntries.slice(keep);
      for (const { fp } of toDelete) {
        try {
          fs.unlinkSync(fp);
        } catch (err) {
          log.debug(`Could not remove old log ${fp}: ${err.message}`);
        }
      }
    } catch (err) {
      log.debug(`Could not prune logs dir: ${err.message}`);
    }
  }

  /**
   * Remove orphan .partial.<pid> files left behind by interrupted downloads.
   * Called at start() — at that moment no download can be in progress, so
   * everything matching the partial pattern is safe to delete.
   */
  cleanupOrphanPartials() {
    if (typeof process.pkg === "undefined") return;
    const exeDir = path.dirname(this.getExeBasePath());
    let entries;
    try {
      entries = fs.readdirSync(exeDir);
    } catch {
      return;
    }
    const partialPattern = /\.partial\.\d+$/;
    for (const name of entries) {
      if (!partialPattern.test(name)) continue;
      const fp = path.join(exeDir, name);
      try {
        fs.unlinkSync(fp);
        log.info(`Removed orphan download partial: ${name}`);
      } catch (err) {
        log.debug(`Could not remove orphan partial ${fp}: ${err.message}`);
      }
    }
  }

  /**
   * true if version `a` is the same or newer than `b` (semver-ish, 3-4 parts).
   */
  isSameOrNewer(a, b) {
    if (a === b) return true;
    return this.isNewer(a, b);
  }
}
