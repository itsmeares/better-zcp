
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";
import crypto from "crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createLogger } from "../utils/logger.ts";
import { getSetting, setSetting, getDb, commitNow } from "../database/init.ts";
import { verifySetupToken, clearSetupToken } from "../utils/setupToken.ts";
import {
  loadOrCreateJwtSecret,
  getJwtSecretPath,
  regenerateJwtSecretFile,
} from "../utils/jwtSecret.ts";
import { readSecret } from "../utils/secrets.ts";
import { getCapabilitiesForRole } from "./permissions.ts";
import {
  getRoleById,
  getRoleByName,
  getRoles,
  RECOVERY_CAPABILITIES,
} from "./permissions.ts";
import { ErrorCode } from "../utils/errorCodes.ts";

const log = createLogger("Auth");

type RefreshSession = {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
};

type ExternalIdentity = {
  issuer: string;
  subject: string;
  email: string | null;
  linkedAt: string;
};

type AuthUser = {
  id: string;
  username: string;
  password?: string | null;
  role: string;
  roleId?: string | number | null;
  tokenGen?: number;
  refreshSessions?: RefreshSession[];
  externalIdentities?: ExternalIdentity[];
  lockedUntil?: string | null;
  failedLoginCount?: number;
  lastLogin?: string | null;
  createdAt?: string;
  [key: string]: any;
};

type AuthRole = {
  id: string | number;
  name: string;
  capabilities: string[];
  isSeeded?: boolean;
};

type AuthenticatedUser = {
  userId: string | null;
  username: string | null;
  role: string;
  tokenGen: number | null;
  authDisabled?: boolean;
};

type AuthenticatedRequest = Request & {
  user?: AuthenticatedUser;
};

type PanelJwtPayload = JwtPayload & {
  userId?: string;
  username?: string;
  role?: string;
  tokenGen?: number;
  type?: string;
  sessionId?: string;
};

type RoleServiceError = Error & {
  code: string;
  status: number;
  params?: unknown;
};

type PublicUser = {
  id: string;
  username: string;
  role: string;
  roleId?: string | number | null;
};

type AuthSessionResult = {
  user: PublicUser & { capabilities?: string[] | null };
  accessToken: string;
  refreshToken: string | null;
};

type ExternalLoginResult =
  | { linked: false; canBootstrapAdmin: boolean }
  | {
      linked: true;
      user: PublicUser;
      accessToken: string;
      refreshToken: string | null;
    };

type ExternalIdentityInput = {
  issuer?: string;
  subject?: string;
  email?: string;
};

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
  "/api/auth/recovery-status",
  "/api/auth/recover-with-code",
  "/api/auth/oidc/status",
  "/api/auth/oidc/login",
  "/api/auth/oidc/callback",
]);

export const USER_ROLES = ["admin", "technician", "moderator"];

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

function makeRoleError(
  code: string,
  message: string,
  status = 400,
  params?: unknown,
): RoleServiceError {
  const err = new Error(message) as RoleServiceError;
  err.code = code;
  err.status = status;
  if (params) err.params = params;
  return err;
}

async function countOtherUsersWithCapability(
  capability: string,
  excludingUserId: string,
): Promise<number> {
  const db = await getDb();
  const users = (db.data.users || []) as AuthUser[];
  const roles = await getRoles() as AuthRole[];
  const roleById = new Map(roles.map((r) => [String(r.id), r]));
  const roleByName = new Map(roles.map((r) => [r.name, r]));

  let count = 0;
  for (const u of users) {
    if (String(u.id) === String(excludingUserId)) continue;
    const role = u.roleId ? roleById.get(String(u.roleId)) : roleByName.get(u.role);
    if (role?.capabilities?.includes(capability)) count++;
  }
  return count;
}

async function assertNoRecoveryLockout(
  userId: string,
  currentCapabilities: string[],
  nextCapabilities: string[],
): Promise<void> {
  for (const capability of RECOVERY_CAPABILITIES) {
    const currentlyGrants = currentCapabilities.includes(capability);
    const willStillGrant = nextCapabilities.includes(capability);
    if (!currentlyGrants || willStillGrant) continue;

    const others = await countOtherUsersWithCapability(capability, userId);
    if (others === 0) {
      throw makeRoleError(
        ErrorCode.ROLE_LOCKOUT_LAST_MANAGER,
        `This change would leave no user able to ${
          capability === "roles.manage" ? "manage roles" : "manage user accounts"
        }.`,
        409,
        { action: capability },
      );
    }
  }
}

class AuthService {
  jwtSecret: string | null;
  initialized: boolean;
  _writeMutex: Promise<unknown>;

  constructor() {
    this.jwtSecret = null;
    this.initialized = false;
    this._writeMutex = Promise.resolve();
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
      .filter((session): session is RefreshSession => session && typeof session.id === "string")
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

  async authenticateAccessToken(token: string): Promise<AuthenticatedUser | null> {
    try {
      const payload = jwt.verify(token, this.jwtSecret as string, {
        algorithms: [JWT_ALGORITHM],
      }) as PanelJwtPayload;
      if (payload.type === "refresh") {
        return null;
      }

      const db = await getDb();
      const users = (db.data.users || []) as AuthUser[];
      const user = users.find((entry) => entry.id === payload.userId);
      if (!user) {
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
        role: user.role,
        tokenGen: currentGen,
      };
    } catch (error) {
      return null;
    }
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

  async createUser(username: string, password: string, role?: string): Promise<PublicUser> {
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
      const isFirstUser = users.length === 0;
      let resolvedRole: string;
      if (isFirstUser) {
        resolvedRole = "admin";
      } else {
        if (!role || !USER_ROLES.includes(role)) {
          throw new Error(`role must be one of: ${USER_ROLES.join(", ")}`);
        }
        resolvedRole = role;
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
        role: resolvedRole,
        createdAt: new Date().toISOString(),
        lastLogin: null,
      };

      users.push(user);
      await commitNow();

      log.info(`User created: ${username} (role: ${resolvedRole})`);
      return { id: user.id, username: user.username, role: user.role };
    });
  }

  async changeUserRole(userId: string, newRole: string): Promise<PublicUser> {
    if (!USER_ROLES.includes(newRole)) {
      throw new Error(`role must be one of: ${USER_ROLES.join(", ")}`);
    }

    const targetRole = await getRoleByName(newRole);
    if (!targetRole) {
      throw new Error(
        `Role "${newRole}" is not configured on this panel. Contact an administrator.`,
      );
    }

    return this.changeUserRoleById(userId, targetRole.id);
  }

  async changeUserRoleById(userId: string, roleId: string | number): Promise<PublicUser> {
    return this._withMutex(async () => {
      const targetRole = await getRoleById(roleId);
      if (!targetRole) {
        throw makeRoleError(
          ErrorCode.ROLE_NOT_FOUND,
          "That role does not exist.",
          404,
        );
      }

      const db = await getDb();
      const users = (db.data.users || []) as AuthUser[];
      const user = users.find((u) => u.id === userId);
      if (!user) {
        throw new Error("User not found");
      }

      const currentRole = user.roleId
        ? await getRoleById(user.roleId)
        : await getRoleByName(user.role);
      const currentCapabilities = currentRole?.capabilities || [];
      const nextCapabilities = targetRole.capabilities || [];

      await assertNoRecoveryLockout(userId, currentCapabilities, nextCapabilities);

      user.role = targetRole.name;
      user.roleId = targetRole.id;
      await commitNow();

      log.info(
        `Role changed for user ${user.username}: ${user.role} (roleId: ${user.roleId})`,
      );
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        roleId: user.roleId,
      };
    });
  }

  async deleteUser(
    userId: string,
    { actingUserId }: { actingUserId?: string | number | null } = {},
  ): Promise<{ id: string; username: string }> {
    return this._withMutex(async () => {
      if (actingUserId && String(actingUserId) === String(userId)) {
        throw makeRoleError(
          ErrorCode.USER_SELF_DELETE_REFUSED,
          "You cannot delete your own account. Ask another administrator to do it instead.",
          400,
        );
      }

      const db = await getDb();
      const users = (db.data.users || []) as AuthUser[];
      const user = users.find((u) => u.id === userId);
      if (!user) {
        throw new Error("User not found");
      }

      const currentRole = user.roleId
        ? await getRoleById(user.roleId)
        : await getRoleByName(user.role);
      const currentCapabilities = currentRole?.capabilities || [];

      await assertNoRecoveryLockout(userId, currentCapabilities, []);

      db.data.users = users.filter((u) => u.id !== userId);
      await commitNow();

      log.info(`Deleted user: ${user.username} (${user.id})`);
      return { id: user.id, username: user.username };
    });
  }

  async login(username: string, password: string, rememberMe = true): Promise<AuthSessionResult> {
    if (!username || !password) {
      throw new Error("Username and password are required");
    }

    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    const user = users.find(
      (u) => u.username.toLowerCase() === username.toLowerCase(),
    );

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
    const capabilities = await getCapabilitiesForRole(user.role);
    return {
      user: { id: user.id, username: user.username, role: user.role, capabilities },
      accessToken,
      refreshToken,
    };
  }

  generateAccessToken(user: AuthUser): string {
    return jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: user.role,
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

  async refreshAccessToken(refreshToken: string): Promise<AuthSessionResult | null> {
    try {
      const payload = jwt.verify(refreshToken, this.jwtSecret as string, {
        algorithms: [JWT_ALGORITHM],
      }) as PanelJwtPayload;
      if (payload.type !== "refresh") {
        throw new Error("Invalid token type");
      }

      const db = await getDb();
      const users = (db.data.users || []) as AuthUser[];
      const user = users.find((u) => u.id === payload.userId);

      if (!user) {
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
      const capabilities = await getCapabilitiesForRole(user.role);
      return {
        user: { id: user.id, username: user.username, role: user.role, capabilities },
        accessToken,
        refreshToken: newRefreshToken,
      };
    } catch (error) {
      return null;
    }
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
    if (!newPassword || newPassword.length < 6) {
      throw new Error("New password must be at least 6 characters");
    }

    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    const user = users.find((u) => u.id === userId);

    if (!user) {
      throw new Error("User not found");
    }

    if (!user.password) {
      throw new Error(
        "This account has no local password set (it signs in via an external provider). Use password reset/recovery to set one instead.",
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
    return true;
  }

  async getUsers(): Promise<PublicUser[]> {
    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      roleId: u.roleId || null,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
    }));
  }


  async loginWithExternalIdentity(
    { issuer, subject }: ExternalIdentityInput = {},
    rememberMe = true,
  ): Promise<ExternalLoginResult> {
    if (!issuer || !subject) {
      throw new Error("issuer and subject are required");
    }

    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    const existing = users.find(
      (u) =>
        Array.isArray(u.externalIdentities) &&
        u.externalIdentities.some(
          (ext) => ext.issuer === issuer && ext.subject === subject,
        ),
    );

    if (!existing) {
      return { linked: false, canBootstrapAdmin: users.length === 0 };
    }

    this.ensureUserAuthState(existing);
    existing.lastLogin = new Date().toISOString();
    const refreshSession = rememberMe
      ? this.createRefreshSession(existing)
      : null;
    await commitNow();

    const accessToken = this.generateAccessToken(existing);
    const refreshToken = refreshSession
      ? this.generateRefreshToken(existing, refreshSession.id)
      : null;

    log.info(`User logged in via OIDC: ${existing.username}`);
    return {
      linked: true,
      user: { id: existing.id, username: existing.username, role: existing.role },
      accessToken,
      refreshToken,
    };
  }

  async bootstrapAdminFromExternalIdentity({
    issuer,
    subject,
    email,
    username,
    setupToken,
  }: ExternalIdentityInput & { username?: string; setupToken?: unknown } = {}): Promise<PublicUser> {
    return this._withMutex(async () => {
      const db = await getDb();
      if (!db.data.users) {
        db.data.users = [];
      }
      if (db.data.users.length > 0) {
        throw new Error(
          "Setup already completed. An admin must link this identity instead.",
        );
      }

      if (!(await verifySetupToken(setupToken))) {
        throw new Error("Invalid or missing setup token");
      }
      if (!issuer || !subject) {
        throw new Error("issuer and subject are required");
      }
      if (!username || typeof username !== "string") {
        throw new Error("username is required");
      }
      if (username.length < 3 || username.length > 32) {
        throw new Error("Username must be 3-32 characters");
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        throw new Error(
          "Username can only contain letters, numbers, underscores and hyphens",
        );
      }

      const user: AuthUser = {
        id: crypto.randomUUID(),
        username,
        password: null, // OIDC-only account — no local password set
        role: "admin",
        externalIdentities: [
          {
            issuer,
            subject,
            email: email || null,
            linkedAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        lastLogin: null,
      };

      db.data.users.push(user);
      await commitNow();
      await clearSetupToken();

      log.info(`First admin account bootstrapped via OIDC: ${username}`);
      return { id: user.id, username: user.username, role: user.role };
    });
  }

  async linkExternalIdentity(
    userId: string,
    { issuer, subject, email }: ExternalIdentityInput = {},
  ): Promise<PublicUser> {
    if (!issuer || !subject) {
      throw new Error("issuer and subject are required");
    }

    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    const user = users.find((u) => u.id === userId);
    if (!user) {
      throw new Error("User not found");
    }

    const claimedElsewhere = users.some(
      (u) =>
        u.id !== userId &&
        Array.isArray(u.externalIdentities) &&
        u.externalIdentities.some(
          (ext) => ext.issuer === issuer && ext.subject === subject,
        ),
    );
    if (claimedElsewhere) {
      throw new Error(
        "This external identity is already linked to a different account",
      );
    }

    if (!Array.isArray(user.externalIdentities)) {
      user.externalIdentities = [];
    }
    const alreadyLinked = user.externalIdentities.some(
      (ext) => ext.issuer === issuer && ext.subject === subject,
    );
    if (!alreadyLinked) {
      user.externalIdentities.push({
        issuer,
        subject,
        email: email || null,
        linkedAt: new Date().toISOString(),
      });
      await commitNow();
    }

    log.info(`Linked external identity to user: ${user.username}`);
    return { id: user.id, username: user.username, role: user.role };
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
      const user = users.find((entry) => entry.id === payload.userId);
      if (!user) {
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

    const user = users.find((u) => u.role === "admin") || users[0];
    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.tokenGen = (user.tokenGen || 0) + 1;
    user.refreshSessions = [];
    await commitNow();

    log.info(`Password reset for user: ${user.username}`);
    return { username: user.username };
  }

  async generateRecoveryCodes(count = 10): Promise<{ codes: string[]; createdAt: string }> {
    const db = await getDb();
    const users = (db.data.users || []) as AuthUser[];
    const user = users.find((u) => u.role === "admin") || users[0];
    if (!user) throw new Error("No user accounts exist. Use setup instead.");

    const codes: string[] = [];
    const hashes: Array<{ hash: string; usedAt: string | null }> = [];
    for (let i = 0; i < count; i++) {
      const raw = crypto.randomBytes(15).toString("base64url").slice(0, 20).toUpperCase();
      const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}`;
      codes.push(code);
      hashes.push({
        hash: crypto.createHash("sha256").update(code, "utf8").digest("hex"),
        usedAt: null,
      });
    }

    await setSetting("authRecoveryCodes", JSON.stringify(hashes));
    await setSetting("authRecoveryCodesCreatedAt", new Date().toISOString());
    log.info(`Generated ${count} recovery codes for user: ${user.username}`);
    return { codes, createdAt: new Date().toISOString() };
  }

  async getRecoveryCodeStatus(): Promise<{
    configured: boolean;
    remaining: number;
    total: number;
    createdAt: string | null;
  }> {
    const stored = await getSetting("authRecoveryCodes");
    const createdAt = await getSetting("authRecoveryCodesCreatedAt");
    let entries: Array<{ hash: string; usedAt: string | null }> = [];
    try {
      entries = (stored ? JSON.parse(stored) : []) as Array<{ hash: string; usedAt: string | null }>;
    } catch {
      entries = [];
    }
    const remaining = entries.filter((entry) => !entry.usedAt).length;
    return { configured: entries.length > 0, remaining, total: entries.length, createdAt: createdAt || null };
  }

  async redeemRecoveryCode(code: string, newPassword: string): Promise<{ username: string; remaining: number }> {
    return this._withMutex(async () => {
      if (typeof code !== "string" || !code.trim()) {
        throw new Error("A recovery code is required");
      }
      const stored = await getSetting("authRecoveryCodes");
      let entries: Array<{ hash: string; usedAt: string | null }> = [];
      try {
        entries = (stored ? JSON.parse(stored) : []) as Array<{ hash: string; usedAt: string | null }>;
      } catch {
        entries = [];
      }
      if (entries.length === 0) {
        throw new Error("No recovery codes have been generated for this panel.");
      }

      const candidate = crypto
        .createHash("sha256")
        .update(code.trim().toUpperCase(), "utf8")
        .digest();
      const match = entries.find((entry) => {
        if (entry.usedAt) return false;
        const storedDigest = Buffer.from(entry.hash, "hex");
        if (storedDigest.length !== candidate.length) return false;
        return crypto.timingSafeEqual(storedDigest, candidate);
      });
      if (!match) {
        throw new Error("That recovery code is not valid or has already been used.");
      }

      const result = await this.resetPassword(newPassword);
      match.usedAt = new Date().toISOString();
      await setSetting("authRecoveryCodes", JSON.stringify(entries));
      const remaining = entries.filter((entry) => !entry.usedAt).length;
      log.info(`Recovery code redeemed for ${result.username}; ${remaining} remaining`);
      return { ...result, remaining };
    });
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

        const needsSetup = await this.needsSetup();
        if (needsSetup) {
          return res
            .status(401)
            .json({ error: "First-run setup required", code: "SETUP_REQUIRED" });
        }

        const authEnabled = await this.isAuthEnabled();
        if (!authEnabled) {
          authenticatedRequest.user = {
            userId: null,
            username: null,
            role: "admin",
            tokenGen: null,
            authDisabled: true,
          };
          return next();
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res
            .status(401)
            .json({ error: "Authentication required", code: "AUTH_REQUIRED" });
        }

        const token = authHeader.substring(7);
        const payload = await this.authenticateAccessToken(token);

        if (!payload) {
          return res
            .status(401)
            .json({ error: "Invalid or expired token", code: "TOKEN_EXPIRED" });
        }

        authenticatedRequest.user = payload;
        next();
      } catch (error: unknown) {
        log.error(`Auth middleware error: ${errorMessage(error)}`);
        return res.status(500).json({ error: "Authentication error" });
      }
    };
  }
}

const authService = new AuthService();
export default authService;

export function requireRole(...roles: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      return res
        .status(401)
        .json({ error: "Authentication required", code: ErrorCode.AUTH_REQUIRED });
    }
    if (roles.includes(user.role)) return next();
    return res.status(403).json({ error: "Insufficient permissions" });
  };
}
