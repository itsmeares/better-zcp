import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { getDataPaths } from "../utils/paths.ts";

const RESET_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_MAX_BYTES = 1024;
const LOOPBACK_REMOTE_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

type RequestLike = {
  headers?: Headers | Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null };
  connection?: { remoteAddress?: string | null };
  app?: { get?: (name: string) => unknown };
};

function headerValue(request: RequestLike, name: string): string {
  const headers = request.headers;
  if (!headers) return "";
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) || "";
  }
  const value = (headers as Record<string, string | string[] | undefined>)[
    name
  ];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function normalizeIpAddress(address: unknown): string {
  if (typeof address !== "string") return "";
  const trimmed = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!trimmed) return "";
  const withoutZone = trimmed.split("%")[0];
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
}

function isDockerBridgeAddress(address: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 172 && second >= 16 && second <= 31;
}

function getLocalPanelAddresses(): Set<string> {
  const addresses = new Set(
    [...LOOPBACK_REMOTE_ADDRESSES]
      .map((address) => normalizeIpAddress(address))
      .filter(Boolean),
  );

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const normalized = normalizeIpAddress(entry.address);
      if (normalized && !isDockerBridgeAddress(normalized)) {
        addresses.add(normalized);
      }
    }
  }
  return addresses;
}

export function getResetTokenPath(): string {
  return path.join(getDataPaths().dataDir, "reset-token.txt");
}

export function isPanelBehindTrustProxy(request: RequestLike): boolean {
  if (typeof request.app?.get === "function") {
    return Boolean(request.app.get("trust proxy"));
  }
  return headerValue(request, "x-panel-trust-proxy") === "1";
}

export function isLocalPanelRequest(request: RequestLike): boolean {
  if (isPanelBehindTrustProxy(request)) return false;

  const candidateAddresses = [
    request.socket?.remoteAddress,
    request.connection?.remoteAddress,
    headerValue(request, "x-panel-remote-address"),
  ]
    .map(normalizeIpAddress)
    .filter(Boolean);

  const localAddresses = getLocalPanelAddresses();
  return candidateAddresses.some((address) => localAddresses.has(address));
}

export function createLocalResetResponse(message: string) {
  return { success: true, resetAvailable: true, message };
}

type ResetTokenFile = {
  tokenPath: string;
  stat: fs.Stats;
  content: Buffer;
};

function readResetTokenFile(): ResetTokenFile | null {
  const tokenPath = getResetTokenPath();
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fs.openSync(tokenPath, "r");
    const stat = fs.fstatSync(fileDescriptor);
    const content =
      stat.size > RESET_TOKEN_MAX_BYTES
        ? Buffer.alloc(0)
        : fs.readFileSync(fileDescriptor);
    return { tokenPath, stat, content };
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
  }
}

export type ResetTokenState = {
  tokenPath: string;
  available: boolean;
  reason: "missing" | "too-large" | "expired" | "too-short" | "ok";
  token: string | null;
  stat?: fs.Stats;
  ageMs?: number;
};

export function getResetTokenState(): ResetTokenState {
  const tokenFile = readResetTokenFile();
  if (!tokenFile) {
    return {
      tokenPath: getResetTokenPath(),
      available: false,
      reason: "missing",
      token: null,
    };
  }

  const { tokenPath, stat, content } = tokenFile;
  if (
    stat.size > RESET_TOKEN_MAX_BYTES ||
    content.byteLength > RESET_TOKEN_MAX_BYTES
  ) {
    return {
      tokenPath,
      available: false,
      reason: "too-large",
      token: null,
      stat,
    };
  }

  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > RESET_TOKEN_MAX_AGE_MS) {
    return {
      tokenPath,
      available: false,
      reason: "expired",
      token: null,
      stat,
    };
  }

  const token = content.toString("utf-8").trim();
  if (!token || token.length < 8) {
    return {
      tokenPath,
      available: false,
      reason: "too-short",
      token: null,
      stat,
    };
  }

  return { tokenPath, available: true, reason: "ok", token, stat, ageMs };
}

export function createLocalResetToken(): { alreadyAvailable: boolean } {
  const tokenState = getResetTokenState();
  if (tokenState.available && tokenState.token) {
    return { alreadyAvailable: true };
  }

  if (
    tokenState.reason === "expired" ||
    tokenState.reason === "too-large" ||
    tokenState.reason === "too-short"
  ) {
    try {
      fs.unlinkSync(tokenState.tokenPath);
    } catch {
      // The caller reports a generic creation failure if the stale file cannot be removed.
      throw new Error("Could not replace the existing reset token file");
    }
  }

  fs.writeFileSync(
    tokenState.tokenPath,
    `${crypto.randomBytes(24).toString("hex")}\n`,
    {
      encoding: "utf-8",
      mode: 0o600,
    },
  );
  return { alreadyAvailable: false };
}

export type ResetTokenCheck =
  { ok: true; tokenPath: string } | { ok: false; error: string; code: string };

export function checkResetToken(candidate: string): ResetTokenCheck {
  const tokenFile = readResetTokenFile();
  if (!tokenFile) {
    return {
      ok: false,
      error:
        "No reset token found. Create data/reset-token.txt on the server first.",
      code: "RESET_TOKEN_NOT_FOUND",
    };
  }

  const { tokenPath, stat, content } = tokenFile;
  if (
    stat.size > RESET_TOKEN_MAX_BYTES ||
    content.byteLength > RESET_TOKEN_MAX_BYTES
  ) {
    return {
      ok: false,
      error: "Reset token file is invalid (too large). Max 1KB.",
      code: "RESET_TOKEN_TOO_LARGE",
    };
  }

  if (Date.now() - stat.mtimeMs > RESET_TOKEN_MAX_AGE_MS) {
    try {
      fs.unlinkSync(tokenPath);
    } catch {
      // Expiration is still the safe result when cleanup is unavailable.
    }
    return {
      ok: false,
      error:
        "Reset token file is older than 24 hours. Recreate it on the server.",
      code: "RESET_TOKEN_EXPIRED",
    };
  }

  const storedToken = content.toString("utf-8").trim();
  if (!storedToken || storedToken.length < 8) {
    return {
      ok: false,
      error:
        "Reset token file is invalid. It must contain at least 8 characters.",
      code: "RESET_TOKEN_TOO_SHORT",
    };
  }

  const candidateDigest = crypto
    .createHash("sha256")
    .update(candidate.trim(), "utf8")
    .digest();
  const storedDigest = crypto
    .createHash("sha256")
    .update(storedToken, "utf8")
    .digest();
  if (!crypto.timingSafeEqual(candidateDigest, storedDigest)) {
    return {
      ok: false,
      error: "Invalid reset token",
      code: "RESET_TOKEN_INVALID",
    };
  }

  return { ok: true, tokenPath };
}

export function removeResetToken(tokenPath: string): void {
  fs.unlinkSync(tokenPath);
}
