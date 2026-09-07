import { describe, expect, it } from "vitest";
import fs from "fs";


const { logCommand, getCommandHistory, flushWrites } = await import("../database/init.ts");
const { getDataPaths } = await import("../utils/paths.ts");

describe("logCommand redacts RCON secrets before persisting", () => {
  it("never writes an adduser password to db.json on disk", async () => {
    const secret = "hunter2-super-secret";
    await logCommand(`adduser "Bob" "${secret}"`, "User added", true);
    await flushWrites();

    const { dataDir } = getDataPaths();
    const dbPath = `${dataDir}/db.json`;
    const raw = fs.readFileSync(dbPath, "utf8");

    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
  });

  it("getCommandHistory (the data GET /history returns) also never surfaces the password", async () => {
    const secret = "another-real-password";
    await logCommand(`adduser "Alice" "${secret}"`, "User added", true);

    const history = await getCommandHistory(10);
    const serialized = JSON.stringify(history);

    expect(serialized).not.toContain(secret);
    expect(history.some((entry) => entry.command === 'adduser "Alice" "[REDACTED]"')).toBe(true);
  });

  it("a password-less adduser (no password argument at all) is stored verbatim -- nothing to redact", async () => {
    await logCommand('adduser "Carol"', "User added", true);

    const history = await getCommandHistory(10);
    expect(history.some((entry) => entry.command === 'adduser "Carol"')).toBe(true);
  });
});
