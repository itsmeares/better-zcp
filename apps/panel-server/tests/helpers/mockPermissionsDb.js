// Shared fixture for tests exercising a requirePermission(...) gate.
//
// requireRole was a pure, synchronous role-name check with no dependency on
// anything -- a gate test could hand it `{ user: { role: "moderator" } }`
// and get an answer with zero setup. requirePermission is DB-backed: it
// resolves req.user.role to a row in the roles collection and checks that
// row's capabilities array. That's the whole point (an operator can edit
// what a role grants), so a test can no longer skip mocking role
// resolution.
//
// DELIBERATELY SELF-CONTAINED -- does NOT import DEFAULT_ROLE_CAPABILITIES
// from services/permissions.js, even though that would avoid a third copy
// of these three arrays. This file is consumed from inside vi.mock(
// "../database/init.js", ...) factories; permissions.js itself imports
// FROM database/init.js, so importing permissions.js here would try to
// resolve database/init.js's mock while that same mock is still being
// constructed -- a real circular deadlock (every gate test in the file
// timed out at exactly the default 5000ms with no error before this was
// split out). apps/panel-server/tests/mockPermissionsDbMatchesSeed.test.js cross-
// checks these against services/permissions.js's real DEFAULT_ROLE_CAPABILITIES
// from a normal (non-mock-factory) import, so the three copies (this one,
// permissions.js's, and database/init.js's migration snapshot) can't drift
// silently.
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
