import { describe, expect, it } from "vitest";


const { runMigrations } = await import("../database/init.js");

function makeSyntheticV1Db() {
  return {
    command_history: [
      { command: "players", response: "3 players online", timestamp: "2026-08-20T10:00:00.000Z" },
      { command: "save", response: "World saved", timestamp: "2026-08-20T11:00:00.000Z" },
    ],
    scheduled_tasks: [
      {
        id: "task-restart-nightly",
        name: "Nightly restart",
        type: "restart",
        cron: "0 4 * * *",
        enabled: true,
      },
      {
        id: "task-backup-6h",
        name: "6-hourly backup",
        type: "backup",
        cron: "0 */6 * * *",
        enabled: true,
      },
    ],
    schedule_history: [
      { taskId: "task-restart-nightly", ranAt: "2026-08-20T04:00:00.000Z", success: true },
    ],
    player_logs: [
      { username: "Deacon", event: "join", timestamp: "2026-08-20T09:00:00.000Z" },
    ],
    server_events: [
      { type: "server_start", timestamp: "2026-08-19T00:00:00.000Z" },
    ],
    tracked_mods: [
      { workshopId: "2874186681", name: "Better FPS", enabled: true },
      { workshopId: "2727930567", name: "Superb Survivors", enabled: false },
    ],
    ignored_mods: ["2999999999"],
    ignored_mod_pairs: [],
    servers: [
      {
        id: "srv-main",
        name: "Muldraugh Main",
        rconPassword: "correct-horse-battery-staple",
        gamePort: 16261,
        rconPort: 27015,
        installPath: "/opt/pzserver",
      },
      {
        id: "srv-pvp",
        name: "PVP Arena",
        rconPassword: "another-secret",
        gamePort: 16263,
        rconPort: 27016,
        installPath: "/opt/pzserver-pvp",
      },
    ],
    player_notes: [
      { username: "Deacon", note: "Trusted builder, has base at West Point" },
    ],
    player_stats: [{ username: "Deacon", kills: 42, deaths: 3 }],
    mod_presets: [
      { name: "Survival Pack", mods: ["2874186681"], workshop_ids: ["2874186681"] },
    ],
    user_templates: [],
    steamid_bans: [],
    performance_history: [
      { timestamp: "2026-08-20T12:00:00.000Z", cpu: 12.5, ramMb: 2048 },
    ],
    bridge_logs: [],
    discord_webhooks: [],
    users: [
      { id: "u-admin", username: "admin1", role: "admin" },
      { id: "u-tech", username: "tech1", role: "technician" },
      { id: "u-mod", username: "mod1", role: "moderator" },
    ],
    active_server_id: "srv-main",
    settings: {
      panel_password: "$2b$10$fakeHashForTestingPurposesOnly",
      discord_token: "fake-discord-token",
      discord_channel_id: "123456789",
      discord_enabled: true,
      auto_restart_on_mod_update: true,
      mod_check_interval: 300000,
      steam_api_key: "FAKE_STEAM_API_KEY",
    },

    activity_log: [
      { type: "login", actor: "admin1", timestamp: "2026-08-19T08:00:00.000Z" },
    ],
    mods: ["2874186681", "2727930567"],
  };
}

describe("v1.2.0 release dry-run: a realistic, fully-populated V1 db migrates cleanly with no data loss", () => {
  it("a db with NO _schemaVersion at all migrates cleanly to the current schema version (v3)", () => {
    const data = runMigrations(makeSyntheticV1Db());
    expect(data._schemaVersion).toBe(3);
  });

  it("every migration is genuinely idempotent: running it a second time is a no-op", () => {
    const once = runMigrations(makeSyntheticV1Db());
    const onceJson = JSON.stringify(once);

    const replayed = { ...once, _schemaVersion: 1 };
    const twice = runMigrations(replayed);

    expect(twice._schemaVersion).toBe(3);
    expect(twice.roles.map((r) => r.id).sort()).toEqual(
      once.roles.map((r) => r.id).sort(),
    );
    for (const role of twice.roles) {
      const downloadCount = role.capabilities.filter((c) => c === "backups.download").length;
      expect(downloadCount).toBeLessThanOrEqual(1);
    }
    const stillCurrent = runMigrations(once);
    expect(JSON.stringify(stillCurrent)).toBe(onceJson);
  });

  it("no data is lost: every non-migration-owned collection survives with its actual contents intact, not merely present as a key", () => {
    const before = makeSyntheticV1Db();
    const after = runMigrations(makeSyntheticV1Db());

    expect(after.servers).toEqual(before.servers);
    expect(after.tracked_mods).toEqual(before.tracked_mods);
    expect(after.scheduled_tasks).toEqual(before.scheduled_tasks);
    expect(after.settings).toEqual(before.settings);
    expect(after.command_history).toEqual(before.command_history);
    expect(after.schedule_history).toEqual(before.schedule_history);
    expect(after.player_logs).toEqual(before.player_logs);
    expect(after.server_events).toEqual(before.server_events);
    expect(after.player_notes).toEqual(before.player_notes);
    expect(after.player_stats).toEqual(before.player_stats);
    expect(after.mod_presets).toEqual(before.mod_presets);
    expect(after.performance_history).toEqual(before.performance_history);
    expect(after.active_server_id).toBe(before.active_server_id);

    expect(after.activity_log).toEqual(before.activity_log);
    expect(after.mods).toEqual(before.mods);

    expect(after.roles.length).toBe(3);
    expect(after.users.map((u) => u.role)).toEqual(before.users.map((u) => u.role));
    for (const user of after.users) {
      expect(user.roleId).toBeTruthy();
    }
  });

  it("rconPassword values inside servers[] survive migration verbatim (the field a real operator would most notice going missing)", () => {
    const after = runMigrations(makeSyntheticV1Db());
    expect(after.servers.find((s) => s.id === "srv-main").rconPassword).toBe(
      "correct-horse-battery-staple",
    );
    expect(after.servers.find((s) => s.id === "srv-pvp").rconPassword).toBe(
      "another-secret",
    );
  });
});
