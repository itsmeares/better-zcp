
import {
  getDb,
  commitNow,
  getRoles,
  getRoleById,
  getRoleByName,
  insertRole,
  replaceRoleById,
  removeRoleById,
  getUsersForRole,
  getUsersForRoleAccounting,
  reassignRoleMembers,
} from "../database/init.js";
import { createLogger } from "../utils/logger.ts";
import { ErrorCode } from "../utils/errorCodes.ts";

const log = createLogger("Permissions");


export const CAPABILITIES = [
  {
    key: "users.manage",
    group: "Users & Roles",
    label: "Manage user accounts",
    description:
      "Create accounts, list them, change which role each one holds, and permanently delete an account.",
  },
  {
    key: "roles.manage",
    group: "Users & Roles",
    label: "Manage roles & permissions",
    description:
      "Create, edit and delete roles, and choose which capabilities each one grants.",
  },

  {
    key: "backups.manage",
    group: "Backups",
    label: "Create, delete & configure backups",
    description:
      "Create manual backups, delete or prune old ones, upload external backups, and change the backup schedule.",
  },
  {
    key: "backups.download",
    group: "Backups",
    label: "Download a backup archive",
    description:
      "Download a backup .zip off the machine -- a full copy of the world save and, if database backups are turned on, the panel's own account data. A different act from creating, deleting or restoring one: this one leaves the machine.",
  },
  {
    key: "backups.restore",
    group: "Backups",
    label: "Restore a backup",
    description:
      "Roll the live world back to an earlier backup -- affects every player currently on the server.",
  },

  {
    key: "server.control",
    group: "Server Lifecycle",
    label: "Start, stop, restart & save the server",
    description:
      "Start, stop, force-stop, restart or save the running server -- however it is deployed, including a Docker-managed one. Docker container status, stats and direct container actions are a separate capability (docker.manage).",
  },
  {
    key: "server.install",
    group: "Server Lifecycle",
    label: "Install & update the server",
    description:
      "Install or update the server through SteamCMD, browse the filesystem to configure it, and verify a discovered install.",
  },
  {
    key: "server.configure",
    group: "Server Lifecycle",
    label: "Edit server configuration",
    description:
      "Edit the server's .ini settings, RCON connection details, and network/path configuration, and reload the server's Lua scripts on a live server.",
  },
  {
    key: "server.wipe",
    group: "Server Lifecycle",
    label: "Wipe the world",
    description:
      "Irreversibly delete map, player or world save data -- including, via the 'clear install folder' action, an install directory that passes a PZ-install marker-file check AND matches a configured server's own recorded install path.",
  },
  {
    key: "server.world_events",
    group: "Server Lifecycle",
    label: "Run world events",
    description:
      "Weather, climate, time of day, ambient sound, zombie hordes (clearing them, not spawning them at anyone), utilities, visual settings and server-attributed broadcast messages -- world-wide effects, not aimed at a specific player. Spawning zombies or sound effects at a named player, targeted lightning/thunder, and impersonating a player in chat are a separate capability, players.endanger_or_impersonate.",
  },

  {
    key: "rcon.execute",
    group: "RCON",
    label: "Run RCON commands",
    description:
      "Connect to RCON and execute arbitrary console commands, including ones that can stop the server. Also grants read access to the full RCON command history -- including real player passwords typed into whitelist commands like adduser.",
  },

  {
    key: "servers.manage",
    group: "Server Setup & Fleet",
    label: "Add, edit & remove configured servers",
    description: "Add, edit, remove or activate a configured server entry.",
  },
  {
    key: "servers.discover",
    group: "Server Setup & Fleet",
    label: "Auto-discover servers on this machine",
    description:
      "Scan any path on the host filesystem you specify for PZ server installs, including reading and parsing the contents of the .ini config files it finds there.",
  },
  {
    key: "templates.manage",
    group: "Server Setup & Fleet",
    label: "Manage server templates",
    description: "Create, import, apply and delete configuration templates.",
  },

  {
    key: "bridge.setup",
    group: "PanelBridge Integration",
    label: "Connect & configure PanelBridge",
    description:
      "Connect or reconfigure the in-game mod bridge -- including entering and storing the SFTP login password used to reach a remote server, browsing arbitrary paths on that server over SFTP, and pointing the local bridge at any absolute host path outside a small blocked-directory list. Also installs the mod.",
  },
  {
    key: "bridge.diagnostics",
    group: "PanelBridge Integration",
    label: "PanelBridge diagnostics",
    description:
      "View the mod's debug log and stats, introspect its API, available handlers and item scripts, run item and vehicle catalog scans, toggle its debug mode, and clear its error log.",
  },
  {
    key: "bridge.command",
    group: "PanelBridge Integration",
    label: "Run any PanelBridge action",
    description:
      "The unrestricted passthrough behind every in-game tool, including ones with no dedicated button.",
  },

  {
    key: "players.moderate",
    group: "Player Authority",
    label: "Discipline players",
    description:
      "Ban, unban, kick or whitelist a player, and change a player's in-game access level -- including granting or revoking admin.",
  },
  {
    key: "players.gm_tools",
    group: "Player Authority",
    label: "Game-master tools",
    description:
      "Spawn items, teleport, and similar trusted event-runner actions.",
  },
  {
    key: "players.view",
    group: "Player Authority",
    label: "View player info",
    description: "Read player details, status and history.",
  },
  {
    key: "players.endanger_or_impersonate",
    group: "Player Authority",
    label: "Endanger or impersonate a player",
    description:
      "Spawn up to 500 zombies directly at a named player's location or right behind them, or trigger a horde aimed at them; aim a gunshot or an attraction sound at their position; strike them with targeted lightning or thunder. Separately, and a different kind of harm: send a general-chat message under any custom author name, including another player's -- making it read as if that player said it themselves.",
  },

  {
    key: "mods.manage",
    group: "Mods",
    label: "Manage mods",
    description:
      "Track, install, configure and permanently delete Workshop mods from disk -- including extracting or overwriting the Steam login session used for Workshop uploads, up to pulling it directly from an installed browser's cookie store on this machine.",
  },

  {
    key: "automation.manage",
    group: "Automation",
    label: "Manage scheduled tasks",
    description: "Create and edit automated restarts, backups and other scheduled jobs.",
  },

  {
    key: "integrations.manage",
    group: "Integrations",
    label: "Manage integrations",
    description: "Configure the Discord bot and similar external hooks.",
  },

  {
    key: "docker.manage",
    group: "Infrastructure",
    label: "Manage the Docker container",
    description:
      "View Docker container status and stats, and run direct container actions from the Docker screen. Starting, stopping and restarting the server itself -- Docker-managed or not -- is governed by server.control, not this capability.",
  },
  {
    key: "chunks.manage",
    group: "Infrastructure",
    label: "Manage map chunks",
    description:
      "Clean up or delete map chunk regions, including from an arbitrary host directory you specify -- not limited to this server's own configured save location -- and configure the chunk save path.",
  },
  {
    key: "serverfiles.manage",
    group: "Infrastructure",
    label: "Manage server files",
    description: "Edit sandbox options, spawn points and other server config files.",
  },

  {
    key: "diagnostics.manage",
    group: "Panel Diagnostics & Settings",
    label: "View panel diagnostics",
    description:
      "View logs, performance history, CORS diagnostics and database statistics, back up the database, compact it -- which permanently trims old records -- and clear stale lock files. Also relocates the panel's data and log directories to any writable path on the host (blocked only from OS system directories and a configured server's own folders), and can move everything already there in the process -- including the JWT signing secret, every server's stored RCON password, and the main database.",
  },
  {
    key: "panel.settings",
    group: "Panel Diagnostics & Settings",
    label: "Manage panel-wide settings",
    description:
      "Change CORS policy, mod-check interval and other app-level settings -- including pointing the panel's HTTPS listener at any certificate/key file on the host -- and configure SSO/OIDC login (client secret included).",
  },
];

const CAPABILITY_KEYS = new Set(CAPABILITIES.map((c) => c.key));

export function isKnownCapability(key) {
  return typeof key === "string" && CAPABILITY_KEYS.has(key);
}

export function listCapabilitiesGrouped() {
  const groups = new Map();
  for (const cap of CAPABILITIES) {
    if (!groups.has(cap.group)) groups.set(cap.group, []);
    groups.get(cap.group).push({
      key: cap.key,
      label: cap.label,
      description: cap.description,
    });
  }
  return Array.from(groups.entries()).map(([group, capabilities]) => ({
    group,
    capabilities,
  }));
}

const RECOVERY_CAPABILITIES = ["roles.manage", "users.manage"];


const TECHNICIAN_CAPABILITIES = [
  "backups.manage",
  "backups.download",
  "server.control",
  "server.install",
  "server.configure",
  "server.world_events",
  "rcon.execute",
  "servers.manage",
  "templates.manage",
  "bridge.setup",
  "bridge.diagnostics",
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "mods.manage",
  "automation.manage",
  "integrations.manage",
  "docker.manage",
  "chunks.manage",
  "serverfiles.manage",
];

const MODERATOR_CAPABILITIES = [
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "server.world_events",
];

export const DEFAULT_ROLE_CAPABILITIES = Object.freeze({
  admin: Object.freeze(CAPABILITIES.map((c) => c.key)),
  technician: Object.freeze(TECHNICIAN_CAPABILITIES),
  moderator: Object.freeze(MODERATOR_CAPABILITIES),
});


export function requirePermission(capability) {
  if (!isKnownCapability(capability)) {
    log.error(
      `requirePermission() called with an unregistered capability: "${capability}" -- refusing every request to this route until fixed.`,
    );
    return (req, res) => {
      res.status(403).json({
        error: "Insufficient permissions",
        code: ErrorCode.PERMISSION_DENIED,
      });
    };
  }

  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Authentication required",
        code: ErrorCode.AUTH_REQUIRED,
      });
    }

    try {
      const role = await getRoleByName(req.user.role);
      if (!role || !Array.isArray(role.capabilities)) {
        return res.status(403).json({
          error: "Insufficient permissions",
          code: ErrorCode.PERMISSION_DENIED,
        });
      }
      if (!role.capabilities.includes(capability)) {
        return res.status(403).json({
          error: "Insufficient permissions",
          code: ErrorCode.PERMISSION_DENIED,
        });
      }
      return next();
    } catch (error) {
      log.error(`requirePermission("${capability}") failed: ${error.message}`);
      return res.status(403).json({
        error: "Insufficient permissions",
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
  };
}

async function getCapabilitiesForRole(roleName) {
  try {
    const role = await getRoleByName(roleName);
    return role && Array.isArray(role.capabilities) ? role.capabilities : null;
  } catch {
    return null;
  }
}

export {
  getRoles,
  getRoleById,
  getRoleByName,
  getUsersForRole,
  getCapabilitiesForRole,
  RECOVERY_CAPABILITIES,
};

async function countUsersWithCapability(capability, excludingRoleId = null) {
  const roles = await getRoles();
  const users = await getUsersForRoleAccounting();
  const grantingRoleIds = new Set(
    roles
      .filter(
        (r) =>
          String(r.id) !== String(excludingRoleId) &&
          Array.isArray(r.capabilities) &&
          r.capabilities.includes(capability),
      )
      .map((r) => String(r.id)),
  );
  const grantingRoleNames = new Set(
    roles
      .filter(
        (r) =>
          String(r.id) !== String(excludingRoleId) &&
          r.isSeeded &&
          Array.isArray(r.capabilities) &&
          r.capabilities.includes(capability),
      )
      .map((r) => r.name),
  );
  let count = 0;
  for (const u of users) {
    if (u.roleId && grantingRoleIds.has(String(u.roleId))) count++;
    else if (!u.roleId && grantingRoleNames.has(u.role)) count++;
  }
  return count;
}

function validateCapabilitiesArray(capabilities) {
  if (!Array.isArray(capabilities)) {
    return { message: "capabilities must be an array" };
  }
  const unknown = capabilities.filter((c) => !isKnownCapability(c));
  if (unknown.length > 0) {
    return { message: `Unknown capability: ${unknown[0]}`, capability: unknown[0] };
  }
  return null;
}

function makeError(code, message, status = 400, params) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (params) err.params = params;
  return err;
}


export async function listRolesWithMemberCounts() {
  const roles = await getRoles();
  const withCounts = [];
  for (const role of roles) {
    const members = await getUsersForRole(role);
    withCounts.push({ ...role, memberCount: members.length });
  }
  return withCounts;
}

export async function createRole({ name, capabilities }) {
  if (typeof name !== "string" || !name.trim()) {
    throw makeError(null, "name is required", 400);
  }
  const trimmedName = name.trim();
  const capError = validateCapabilitiesArray(capabilities);
  if (capError) {
    throw makeError(
      ErrorCode.INVALID_CAPABILITY,
      capError.message,
      400,
      capError.capability !== undefined ? { capability: capError.capability } : undefined,
    );
  }

  const existingRoles = await getRoles();
  if (existingRoles.some((r) => r.name === trimmedName)) {
    throw makeError(
      ErrorCode.ROLE_NAME_TAKEN,
      `A role named "${trimmedName}" already exists`,
      409,
      { name: trimmedName },
    );
  }

  const role = {
    id: `role-${randomToken()}`,
    name: trimmedName,
    capabilities: [...new Set(capabilities)],
    isSeeded: false,
    createdAt: new Date().toISOString(),
  };
  await insertRole(role);
  return role;
}

async function checkLockoutRulesForCapabilityChange({
  roleId,
  existingCapabilities,
  nextCapabilities,
  actingUser,
  confirmSelfCapabilityLoss,
}) {
  for (const capability of RECOVERY_CAPABILITIES) {
    const currentlyGrants = existingCapabilities.includes(capability);
    const willStillGrant = nextCapabilities.includes(capability);
    if (!currentlyGrants || willStillGrant) continue;

    const othersWithCapability = await countUsersWithCapability(capability, roleId);
    if (othersWithCapability === 0) {
      throw makeError(
        ErrorCode.ROLE_LOCKOUT_LAST_MANAGER,
        `This change would leave no user able to ${
          capability === "roles.manage" ? "manage roles" : "manage user accounts"
        }.`,
        409,
        { action: capability },
      );
    }

    if (actingUser) {
      const actingRole = await getRoleByName(actingUser.role);
      const actingUserIsInThisRole =
        actingRole && String(actingRole.id) === String(roleId);
      if (actingUserIsInThisRole && !confirmSelfCapabilityLoss) {
        throw makeError(
          ErrorCode.ROLE_SELF_CAPABILITY_LOSS_CONFIRM,
          `This would remove your own ability to ${
            capability === "roles.manage" ? "manage roles" : "manage user accounts"
          }. Set confirmSelfCapabilityLoss: true to proceed anyway.`,
          409,
          { action: capability },
        );
      }
    }
  }
}

export async function updateRole(
  id,
  { name, capabilities },
  { actingUser, confirmSelfCapabilityLoss = false } = {},
) {
  const roles = await getRoles();
  const existing = roles.find((r) => String(r.id) === String(id));
  if (!existing) {
    throw makeError(ErrorCode.ROLE_NOT_FOUND, "Role not found", 404);
  }

  const nextName = typeof name === "string" && name.trim() ? name.trim() : existing.name;

  if (existing.isSeeded && nextName !== existing.name) {
    throw makeError(null, "Built-in roles cannot be renamed.", 403);
  }

  if (roles.some((r) => String(r.id) !== String(id) && r.name === nextName)) {
    throw makeError(
      ErrorCode.ROLE_NAME_TAKEN,
      `A role named "${nextName}" already exists`,
      409,
      { name: nextName },
    );
  }

  let nextCapabilities = existing.capabilities;
  if (capabilities !== undefined) {
    const capError = validateCapabilitiesArray(capabilities);
    if (capError) {
      throw makeError(
        ErrorCode.INVALID_CAPABILITY,
        capError.message,
        400,
        capError.capability !== undefined ? { capability: capError.capability } : undefined,
      );
    }
    nextCapabilities = [...new Set(capabilities)];

    await checkLockoutRulesForCapabilityChange({
      roleId: id,
      existingCapabilities: existing.capabilities,
      nextCapabilities,
      actingUser,
      confirmSelfCapabilityLoss,
    });
  }

  const updated = {
    ...existing,
    name: nextName,
    capabilities: nextCapabilities,
    updatedAt: new Date().toISOString(),
  };
  const written = await replaceRoleById(id, updated);
  if (!written) {
    throw makeError(ErrorCode.ROLE_NOT_FOUND, "Role not found", 404);
  }

  if (nextName !== existing.name) {
    const db = await getDb();
    const users = db.data.users || [];
    let changed = false;
    for (const u of users) {
      if (String(u.roleId) === String(existing.id)) {
        u.role = nextName;
        changed = true;
      }
    }
    if (changed) await commitNow();
  }

  return updated;
}

export async function deleteRole(id, { reassignTo, actingUser } = {}) {
  const role = await getRoleById(id);
  if (!role) {
    throw makeError(ErrorCode.ROLE_NOT_FOUND, "Role not found", 404);
  }
  if (role.isSeeded) {
    throw makeError(
      ErrorCode.ROLE_IS_SEEDED,
      "Built-in roles cannot be deleted.",
      403,
    );
  }
  const members = await getUsersForRole(role);

  if (members.length > 0 && !reassignTo) {
    throw makeError(
      ErrorCode.ROLE_HAS_MEMBERS,
      `${members.length} user(s) still hold this role. Pass reassignTo to move them to another role first.`,
      409,
      { count: members.length },
    );
  }

  let targetRole = null;
  if (reassignTo) {
    targetRole = await getRoleById(reassignTo);
    if (!targetRole) {
      throw makeError(ErrorCode.ROLE_NOT_FOUND, "reassignTo role not found", 404);
    }
  }

  if (members.length > 0) {
    await checkLockoutRulesForCapabilityChange({
      roleId: role.id,
      existingCapabilities: role.capabilities,
      nextCapabilities: targetRole ? targetRole.capabilities : [],
      actingUser,
      confirmSelfCapabilityLoss: true, // deletion is explicit; rule 2's confirm is implied by the delete action itself
    });
  }

  let reassigned = 0;
  if (targetRole) {
    reassigned = await reassignRoleMembers(role, targetRole);
  }

  const removed = await removeRoleById(id);
  if (!removed) {
    throw makeError(ErrorCode.ROLE_NOT_FOUND, "Role not found", 404);
  }
  return { deleted: true, reassigned, reassignedTo: targetRole?.id || null };
}

function randomToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
