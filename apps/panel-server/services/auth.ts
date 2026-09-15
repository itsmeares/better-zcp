import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";
import crypto from "crypto";
import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "../http/startApiRouter.ts";
import { createLogger } from "../utils/logger.ts";
import { getSetting, setSetting, getDb, commitNow } from "../database/init.ts";
import {
  loadOrCreateJwtSecret,
  getJwtSecretPath,
  regenerateJwtSecretFile,
} from "../utils/jwtSecret.ts";
import { readSecret } from "../utils/secrets.ts";

const log = createLogger("Auth");

type RefreshSession = {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
};

type AuthUser = {
  id: string;
  username: string;
  password?: string | null;
  role?: string;
  tokenGen?: number;
  refreshSessions?: RefreshSession[];
  lockedUntil?: string | null;
  failedLoginCount?: number;
  lastLogin?: string | null;
  createdAt?: string;
  [key: string]: any;
};

export type AuthenticatedUser = {
  userId: string | null;
  username: string | null;
  tokenGen: number | null;
  authDisabled?: boolean;
};

export type ApiAuthenticationResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; status: 401; error: string; code: string };

type AuthenticatedRequest = Request & {
  user?: AuthenticatedUser;
};

type PanelJwtPayload = JwtPayload & {
  userId?: string;
  username?: string;
  tokenGen?: number;
  type?: string;
  sessionId?: string;
};

type PublicUser = {
  id: string;
  username: string;
  createdAt?: string;
  lastLogin?: string | null;
};

type AuthSessionResult = {
  user: PublicUser;
  accessToken: string;
  refreshToken: string | null;
};

export type SessionRevocationEvent =
  { scope: "all" } | { scope: "user"; userId: string };

type SessionRevocationCallback = (event: SessionRevocationEvent) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PUBLIC_AUTH_PATHS = new Set([
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/auth/reset-status",
  "/api/auth/reset-token/local",
  "/api/auth/reset-password",
]);

const BCRYPT_ROUNDS = 12;
export const ACCESS_TOKEN_EXPIRY = "15m";
const JWT_ALGORITHM = "HS256";
const REFRESH_TOKEN_EXPIRY = "30d";
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REFRESH_SESSIONS = 5;
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const DUMMY_BCRYPT_HASH =
  "$2a$12$CwTycUXWue0Thq9StjUM0uJ8u2H8ekjqOGWjF/9JMlSlL5C.tZgqe";

function getAdminUser(users: AuthUser[]): AuthUser | null {
  return users.find((user) => user.role === "admin") || users[0] || null;
}

const sessionRevocationCallbacks = new Set<SessionRevocationCallback>();

export function onSessionRevoked(
  callback: SessionRevocationCallback,
): () => void {
  sessionRevocationCallbacks.add(callback);
  return () => sessionRevocationCallbacks.delete(callback);
}

function emitSessionRevoked(event: SessionRevocationEvent): void {
  for (const callback of sessionRevocationCallbacks) {
    try {
      callback(event);
    } catch (error: unknown) {
      log.warn(`Session-revocation callback failed: ${errorMessage(error)}`);
    }
  }
}

class AuthService {
  jwtSecret: string | null;
  initialized: boolean;
  private initializationPromise: Promise<void> | null;
  _writeMutex: Promise<unknown>;

  constructor() {
    this.jwtSecret = null;
    this.initialized = false;
    this.initializationPromise = null;
    this._writeMutex = Promise.resolve();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.jwtSecret) return;
    this.initializationPromise ??= this.init();
    try {
      await this.initializationPromise;
    } catch (error) {
      this.initializationPromise = null;
      throw error;
    }
  }

  _withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._writeMutex.then(fn, fn);
    this._writeMutex = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  ensureUserAuthState(user: AuthUser): void {
    if (!Number.isInteger(user.tokenGen)) {
      user.tokenGen = 0;
    }

    if (!Array.isArray(user.refreshSessions)) {
      user.refreshSessions = [];
    }

    const now = Date.now();
    user.refreshSessions = user.refreshSessions
      .filter(
        (session): session is RefreshSession =>
          session && typeof session.id === "string",
      )
      .filter((session) => {
        const expiresAt = Date.parse(session.expiresAt || "");
        return Number.isNaN(expiresAt) || expiresAt > now;
      })
      .slice(-MAX_REFRESH_SESSIONS);
  }

  createRefreshSession(user: AuthUser): RefreshSession {
    this.ensureUserAuthState(user);

    const timestamp = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(),
      createdAt: timestamp,
      lastUsedAt: timestamp,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS).toISOString(),
    };

    user.refreshSessions!.push(session);
    if (user.refreshSessions!.length > MAX_REFRESH_SESSIONS) {
      user.refreshSessions = user.refreshSessions!.slice(-MAX_REFRESH_SESSIONS);
    }

    return session;
  }

  findRefreshSession(user: AuthUser, sessionId: string): RefreshSession | null {
    this.ensureUserAuthState(user);
    return (
      user.refreshSessions!.find((session) => session.id === sessionId) || null
    );
  }

  revokeRefreshSession(user: AuthUser, sessionId: string): boolean {
    this.ensureUserAuthState(user);
    const initialLength = user.refreshSessions!.length;
    user.refreshSessions = user.refreshSessions!.filter(
      (session) => session.id !== sessionId,
    );
    return user.refreshSessions.length !== initialLength;
  }

  async authenticateAccessToken(
    token: string,
  ): Promise<AuthenticatedUser | null> {
    try {
      await this.ensureInitialized();
      const payload = jwt.verify(token, this.jwtSecret as string, {
        algorithms: [JWT_ALGORITHM],
      }) as PanelJwtPayload;
      if (payload.type === "refresh") {
        return null;
      }

      const db = await getDb();
      const users = (db.data.users || []) as AuthUser[];
      const user = getAdminUser(users);
      if (!user || user.id !== payload.userId) {
        return null;
      }

      this.ensureUserAuthState(user);
      const currentGen = user.tokenGen || 0;
      const tokenGen = payload.tokenGen ?? 0;
      if (tokenGen !== currentGen) {
        return null;
      }

      return {
        userId: user.id,
        username: user.username,
        tokenGen: currentGen,
      };
    } catch (error) {
      return null;
    }
  }

  async authenticateApiRequest(
    authHeader: string | null | undefined,
  ): Promise<ApiAuthenticationResult> {
    if (await this.needsSetup()) {
      return {
        ok: false,
        status: 401,
        error: "First-run setup required",
        code: "SETUP_REQUIRED",
      };
    }

    if (!(await this.isAuthEnabled())) {
      return {
        ok: true,
        user: {
          userId: null,
          username: null,
          tokenGen: null,
          authDisabled: true,
        },
      };
    }

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        ok: false,
        status: 401,
        error: "Authentication required",
        code: "AUTH_REQUIRED",
      };
    }

    const user = await this.authenticateAccessToken(authHeader.substring(7));
    if (!user) {
      return {
        ok: false,
        status: 401,
        error: "Invalid or expired token",
        code: "TOKEN_EXPIRED",
      };
    }

    return { ok: true, user };
  }

  async init(): Promise<void> {
    try {
      const legacySecret = await getSetting("jwtSecret");
      const { secret, source } = await loadOrCreateJwtSecret({
        legacyValue: legacySecret || null,
      });
      this.jwtSecret = secret;
      this.initialized = true;

      if (legacySecret) {
        await setSetting("jwtSecret", null);
        await commitNow();
        if (source === "env") {
          log.warn(
            "Removed a leftover JWT secret from db.json — a JWT_SECRET " +
              "environment override is in effect, so the db.json copy was " +
              "already unused.",
          );
        } else {
          log.warn(
            `Moved the JWT signing key out of db.json into ${getJwtSecretPath()}. ` +
              "Existing sessions are unaffected — same key, safer location. " +
              "Backups taken before this upgrade still contain the old copy " +
              "in db.json; this change does not retroactively clean those up.",
          );
        }
      } else if (source === "generated") {
        log.info("Generated new JWT secret");
      }

      log.info("Auth service initialized");
    } catch (error: unknown) {
      log.error(`Failed to initialize auth service: ${errorMessage(error)}`);
      throw error;
    }
  }

  async regenerateJwtSecret(): Promise<{ path: string }> {
    if (readSecret("JWT_SECRET")) {
      throw new Error(
        "JWT secret is set via the JWT_SECRET environment variable — rotate " +
          "it there and restart the panel instead. This action only manages " +
          "the auto-generated key file.",
      );
    }
    const { secret, path: secretPath } = regenerateJwtSecretFile();
    this.jwtSecret = secret;
    log.warn(
      `JWT signing key regenerated by admin action (${secretPath}). Every ` +
        "existing access and refresh token is now invalid — every user, on " +
        "every device, must log in again.",
    );
    emitSessionRevoked({ scope: "all" });
    return { path: secretPath };
  }

  async needsSetup(): Promise<boolean> {
    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    return users.length === 0;
  }

  async isAuthEnabled(): Promise<boolean> {
    const authEnabled = await getSetting("authEnabled");
    if (authEnabled === undefined || authEnabled === null) {
      const needsSetup = await this.needsSetup();
      return !needsSetup;
    }
    return authEnabled !== false;
  }

  async createAdmin(username: string, password: string): Promise<PublicUser> {
    return this._withMutex(async () => {
      if (!username || !password) {
        throw new Error("Username and password are required");
      }

      if (username.length < 3 || username.length > 32) {
        throw new Error("Username must be 3-32 characters");
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        throw new Error(
          "Username can only contain letters, numbers, underscores and hyphens",
        );
      }

      if (password.length < 6) {
        throw new Error("Password must be at least 6 characters");
      }

      if (password.length > 128) {
        throw new Error("Password must be 128 characters or fewer");
      }

      const db = await getDb();
      if (!db.data.users) {
        db.data.users = [];
      }

      const users = db.data.users as AuthUser[];
      if (users.length > 0) {
        throw new Error("Setup already completed");
      }

      const existing = users.find(
        (u) => u.username.toLowerCase() === username.toLowerCase(),
      );
      if (existing) {
        throw new Error("Username already exists");
      }

      const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = {
        id: crypto.randomUUID(),
        username,
        password: hashedPassword,
        createdAt: new Date().toISOString(),
        lastLogin: null,
      };

      users.push(user);
      await commitNow();

      log.info(`Admin account created: ${username}`);
      return {
        id: user.id,
        username: user.username,
      };
    });
  }

  async login(
    username: string,
    password: string,
    rememberMe = true,
  ): Promise<AuthSessionResult> {
    if (!username || !password) {
      throw new Error("Username and password are required");
    }

    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    const admin = getAdminUser(users);
    const user =
      admin?.username.toLowerCase() === username.toLowerCase() ? admin : null;

    if (!user) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      throw new Error("Invalid username or password");
    }

    const lockedUntil = user.lockedUntil ? Date.parse(user.lockedUntil) : 0;
    if (lockedUntil && lockedUntil > Date.now()) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      throw new Error("Invalid username or password");
    }

    let valid;
    if (user.password) {
      valid = await bcrypt.compare(password, user.password);
    } else {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      valid = false;
    }
    if (!valid) {
      user.failedLoginCount = (user.failedLoginCount || 0) + 1;
      if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
        user.lockedUntil = new Date(
          Date.now() + LOCKOUT_DURATION_MS,
        ).toISOString();
        user.failedLoginCount = 0;
        log.warn(
          `Account locked due to repeated failed logins: ${user.username}`,
        );
      }
      try {
        await commitNow();
      } catch (error: unknown) {
        log.error(
          `Failed to persist failed-login state for ${user.username}: ${errorMessage(error)}`,
        );
      }
      throw new Error("Invalid username or password");
    }

    user.failedLoginCount = 0;
    user.lockedUntil = null;

    this.ensureUserAuthState(user);

    user.lastLogin = new Date().toISOString();
    const refreshSession = rememberMe ? this.createRefreshSession(user) : null;
    await commitNow();

    const accessToken = this.generateAccessToken(user);
    const refreshToken = refreshSession
      ? this.generateRefreshToken(user, refreshSession.id)
      : null;

    log.info(`User logged in: ${username}`);
    return {
      user: { id: user.id, username: user.username },
      accessToken,
      refreshToken,
    };
  }

  generateAccessToken(user: AuthUser): string {
    return jwt.sign(
      {
        userId: user.id,
        username: user.username,
        tokenGen: user.tokenGen || 0,
      },
      this.jwtSecret as string,
      { algorithm: JWT_ALGORITHM, expiresIn: ACCESS_TOKEN_EXPIRY },
    );
  }

  generateRefreshToken(user: AuthUser, sessionId: string): string {
    return jwt.sign(
      {
        userId: user.id,
        type: "refresh",
        tokenGen: user.tokenGen || 0,
        sessionId,
      },
      this.jwtSecret as string,
      { algorithm: JWT_ALGORITHM, expiresIn: REFRESH_TOKEN_EXPIRY },
    );
  }

  verifyAccessToken(token: string): PanelJwtPayload | null {
    try {
      const payload = jwt.verify(token, this.jwtSecret as string, {
        algorithms: [JWT_ALGORITHM],
      }) as PanelJwtPayload;
      if (payload.type === "refresh") return null;
      return payload;
    } catch (error) {
      return null;
    }
  }

  async refreshAccessToken(
    refreshToken: string,
  ): Promise<AuthSessionResult | null> {
    try {
      const payload = jwt.verify(refreshToken, this.jwtSecret as string, {
        algorithms: [JWT_ALGORITHM],
      }) as PanelJwtPayload;
      if (payload.type !== "refresh") {
        throw new Error("Invalid token type");
      }

      const db = await getDb();
      const users = (db.data.users || []) as AuthUser[];
      const user = getAdminUser(users);

      if (!user || user.id !== payload.userId) {
        throw new Error("User not found");
      }

      this.ensureUserAuthState(user);

      const currentGen = user.tokenGen || 0;
      const tokenGen = payload.tokenGen ?? 0;
      if (tokenGen !== currentGen) {
        throw new Error("Refresh token has been revoked");
      }

      if (!payload.sessionId) {
        throw new Error("Refresh token session is missing");
      }

      if (!this.findRefreshSession(user, payload.sessionId)) {
        throw new Error("Refresh token session is no longer active");
      }

      this.revokeRefreshSession(user, payload.sessionId);
      const newSession = this.createRefreshSession(user);
      await commitNow();

      const accessToken = this.generateAccessToken(user);
      const newRefreshToken = this.generateRefreshToken(user, newSession.id);
      return {
        user: { id: user.id, username: user.username },
        accessToken,
        refreshToken: newRefreshToken,
      };
    } catch (error) {
      return null;
    }
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    if (!newPassword || newPassword.length < 6) {
      throw new Error("New password must be at least 6 characters");
    }

    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    const user = getAdminUser(users);

    if (!user || user.id !== userId) {
      throw new Error("User not found");
    }

    if (!user.password) {
      throw new Error(
        "This account has no local password set. Use the local password reset flow to set one.",
      );
    }

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      throw new Error("Current password is incorrect");
    }

    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.tokenGen = (user.tokenGen || 0) + 1;
    user.refreshSessions = [];
    await commitNow();

    log.info(`Password changed for user: ${user.username}`);
    emitSessionRevoked({ scope: "user", userId: user.id });
    return true;
  }

  async getUsers(): Promise<PublicUser[]> {
    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    const user = getAdminUser(users);
    return user
      ? [
          {
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
          },
        ]
      : [];
  }

  async logout(refreshToken: string | null | undefined): Promise<boolean> {
    if (!refreshToken) {
      return false;
    }

    try {
      const payload = jwt.verify(refreshToken, this.jwtSecret as string, {
        algorithms: [JWT_ALGORITHM],
      }) as PanelJwtPayload;
      if (
        !payload ||
        typeof payload !== "object" ||
        payload.type !== "refresh" ||
        !payload.sessionId ||
        !payload.userId
      ) {
        return false;
      }

      const db = await getDb();
      const users = (db.data.users || []) as AuthUser[];
      const user = getAdminUser(users);
      if (!user || user.id !== payload.userId) {
        return false;
      }

      this.ensureUserAuthState(user);
      const currentGen = user.tokenGen || 0;
      if ((payload.tokenGen ?? 0) !== currentGen) {
        return false;
      }

      if (!this.findRefreshSession(user, payload.sessionId)) {
        return false;
      }

      const revoked = this.revokeRefreshSession(user, payload.sessionId);
      if (revoked) {
        await commitNow();
        emitSessionRevoked({ scope: "user", userId: user.id });
      }

      return revoked;
    } catch (error) {
      return false;
    }
  }

  async resetPassword(newPassword: string): Promise<{ username: string }> {
    if (
      !newPassword ||
      typeof newPassword !== "string" ||
      newPassword.length < 6
    ) {
      throw new Error("Password must be at least 6 characters");
    }
    if (newPassword.length > 128) {
      throw new Error("Password must be 128 characters or fewer");
    }

    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    if (users.length === 0) {
      throw new Error("No user accounts exist. Use setup instead.");
    }

    const user = getAdminUser(users)!;
    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.tokenGen = (user.tokenGen || 0) + 1;
    user.refreshSessions = [];
    await commitNow();

    log.info(`Password reset for user: ${user.username}`);
    emitSessionRevoked({ scope: "user", userId: user.id });
    return { username: user.username };
  }

    middleware(): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
      const authenticatedRequest = req as AuthenticatedRequest;
      try {
        if (!req.path.startsWith("/api")) {
          return next();
        }

        if (PUBLIC_AUTH_PATHS.has(req.path)) {
          return next();
        }

        if (req.path === "/api/health") {
          return next();
        }

        if (
          req.path.startsWith("/api/map/tiles/") ||
          req.path.startsWith("/api/map/b41tiles/") ||
          req.path.startsWith("/api/map/toptiles/")
        ) {
          return next();
        }

        if (req.path.startsWith("/api/mods/thumbnail/")) {
          return next();
        }

        if (req.path === "/api/debug/client-errors") {
          return next();
        }

        const result = await this.authenticateApiRequest(
          req.headers.authorization,
        );
        if (!result.ok) {
          return res.status(result.status).json({
            error: result.error,
            code: result.code,
          });
        }

        authenticatedRequest.user = result.user;
        return next();
      } catch (error: unknown) {
        log.error(`Auth middleware error: ${errorMessage(error)}`);
        return res.status(500).json({ error: "Authentication error" });
      }
    };
  }
}

const AUTH_SERVICE_KEY = "__better_zcp_auth_service__";
const authRuntime = globalThis as typeof globalThis & {
  [AUTH_SERVICE_KEY]?: AuthService;
};
const authService = (authRuntime[AUTH_SERVICE_KEY] ??= new AuthService());
export default authService;
