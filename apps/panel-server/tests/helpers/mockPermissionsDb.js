const ADMIN_CAPABILITIES = [
  "users.manage",
  "roles.manage",
  "backups.manage",
  "backups.download",
  "backups.restore",
  "server.control",
  "server.install",
  "server.configure",
  "server.wipe",
  "server.world_events",
  "rcon.execute",
  "servers.manage",
  "servers.discover",
  "templates.manage",
  "bridge.setup",
  "bridge.diagnostics",
  "bridge.command",
  "players.moderate",
  "players.gm_tools",
  "players.view",
  "players.endanger_or_impersonate",
  "mods.manage",
  "automation.manage",
  "integrations.manage",
  "docker.manage",
  "chunks.manage",
  "serverfiles.manage",
  "diagnostics.manage",
  "panel.settings",
];

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

export const TEST_ROLE_CAPABILITIES = Object.freeze({
  admin: Object.freeze(ADMIN_CAPABILITIES),
  technician: Object.freeze(TECHNICIAN_CAPABILITIES),
  moderator: Object.freeze(MODERATOR_CAPABILITIES),
});

export const TEST_ROLES = {
  admin: { id: "role-admin", name: "admin", capabilities: [...ADMIN_CAPABILITIES], isSeeded: true },
  technician: {
    id: "role-technician",
    name: "technician",
    capabilities: [...TECHNICIAN_CAPABILITIES],
    isSeeded: true,
  },
  moderator: {
    id: "role-moderator",
    name: "moderator",
    capabilities: [...MODERATOR_CAPABILITIES],
    isSeeded: true,
  },
};

export async function mockGetRoleByName(name) {
  return TEST_ROLES[name] || null;
}
