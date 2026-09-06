import { describe, expect, it } from "vitest";


const { summarizeRconRejections, buildRconCommandRejectionsCheck } = await import(
  "../routes/debug.js"
);

function classify(response) {
  if (typeof response !== "string" || !response) return null;
  if (/^Unknown command\b/i.test(response)) return { error: response, response };
  if (/^Wrong arguments\b/i.test(response)) return { error: response, response };
  if (/^Not enough rights\b/i.test(response)) return { error: response, response };
  if (/can only be run from in-game/i.test(response)) return { error: response, response };
  return null;
}

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function entry({ command, response, success, hoursAgo }) {
  return {
    command,
    response,
    success: success ? 1 : 0,
    executed_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
  };
}

describe("summarizeRconRejections", () => {
  it("counts only success:0 entries whose stored text re-classifies as a real game rejection", () => {
    const history = [
      entry({ command: "kickuser", response: "Not enough rights. The RCON account's role does not have permission to run this command.", success: false, hoursAgo: 1 }),
      entry({ command: "godmodplayer", response: "Server is starting...", success: false, hoursAgo: 1 }),
      entry({ command: "players", response: "Players connected (2)", success: true, hoursAgo: 1 }),
    ];
    const summary = summarizeRconRejections(history, classify, { now: NOW });
    expect(summary.total).toBe(1);
    expect(summary.breakdown).toEqual([{ command: "kickuser", count: 1 }]);
  });

  it("excludes entries outside the window even if they're real rejections", () => {
    const history = [
      entry({ command: "kickuser", response: "Not enough rights. Reason.", success: false, hoursAgo: 30 }),
    ];
    const summary = summarizeRconRejections(history, classify, { now: NOW, windowMs: 24 * HOUR });
    expect(summary.total).toBe(0);
  });

  it("groups repeated rejections of the same command into one breakdown entry with the right count", () => {
    const history = [
      entry({ command: "kickuser", response: "Not enough rights. Reason.", success: false, hoursAgo: 1 }),
      entry({ command: "kickuser", response: "Not enough rights. Reason.", success: false, hoursAgo: 2 }),
      entry({ command: "releasesafehouse", response: "This command can be executed only from the game. This command can only be run from in-game, not over RCON.", success: false, hoursAgo: 3 }),
    ];
    const summary = summarizeRconRejections(history, classify, { now: NOW });
    expect(summary.total).toBe(3);
    expect(summary.breakdown).toEqual(
      expect.arrayContaining([
        { command: "kickuser", count: 2 },
        { command: "releasesafehouse", count: 1 },
      ]),
    );
  });

  it("collects a distinct reason hint per rejection SHAPE seen, not per occurrence", () => {
    const history = [
      entry({ command: "kickuser", response: "Not enough rights. Reason.", success: false, hoursAgo: 1 }),
      entry({ command: "banid", response: "Not enough rights. Reason.", success: false, hoursAgo: 2 }),
      entry({ command: "somecmd", response: "Unknown command. Not available.", success: false, hoursAgo: 3 }),
    ];
    const summary = summarizeRconRejections(history, classify, { now: NOW });
    expect(summary.reasonHints).toHaveLength(2);
  });

  it("returns null (fail-closed input) when no classify function is available", () => {
    expect(summarizeRconRejections([], null, { now: NOW })).toBeNull();
    expect(summarizeRconRejections([], undefined, { now: NOW })).toBeNull();
  });
});

describe("buildRconCommandRejectionsCheck", () => {
  it("ok when nothing was rejected in the window", () => {
    const check = buildRconCommandRejectionsCheck({ total: 0, breakdown: [], reasonHints: [] });
    expect(check.status).toBe("ok");
    expect(check.id).toBe("rcon.commandRejections");
    expect(check.message).toMatch(/no rcon commands have been rejected/i);
    expect(check.hint).toMatch(/Console page's command history/);
  });

  it("warn names the count and per-command breakdown, and includes only the relevant reason hints plus the closing line", () => {
    const check = buildRconCommandRejectionsCheck({
      total: 3,
      breakdown: [
        { command: "kickuser", count: 2 },
        { command: "releasesafehouse", count: 1 },
      ],
      reasonHints: ["The RCON account lacks permission on the GAME SERVER. This is the game's own admin access level, separate from this panel's Roles & Permissions — fix in-game or via setaccesslevel."],
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain("3 commands were rejected");
    expect(check.message).toContain("kickuser (x2)");
    expect(check.message).toContain("releasesafehouse (x1)");
    expect(check.hint).toContain("GAME SERVER");
    expect(check.hint).toContain("Console page's command history");
    expect(check.params).toMatchObject({ total: 3 });
  });

  it("fails CLOSED to warn (not ok) on an unrecognised/unavailable summary, same rule as worldmap.tiles.buildDetect", () => {
    expect(buildRconCommandRejectionsCheck(null).status).toBe("warn");
    expect(buildRconCommandRejectionsCheck(undefined).status).toBe("warn");
    expect(buildRconCommandRejectionsCheck({}).status).toBe("warn");
    expect(buildRconCommandRejectionsCheck({ total: "3", breakdown: [] }).status).toBe("warn");
  });
});
