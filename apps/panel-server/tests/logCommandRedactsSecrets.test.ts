import { scopedTests } from "./helpers/serverScope.ts";
import { createServer } from "../database/init.ts";
const it = scopedTests(async () => (await createServer({serverName: "test"})).id);
import { describe, expect } from "vite-plus/test";
import fs from "fs";


const { logCommand, getCommandHistory } = await import("../database/init.ts");
const { getDataPaths } = await import("../utils/paths.ts");

describe("logCommand redacts RCON secrets before persisting", () => {
  it("never writes an adduser password to panel.sqlite on disk", async () => {
    const secret = "hunter2-super-secret";
    await logCommand(`adduser "Bob" "${secret}"`, "User added", true);

    const { dataDir } = getDataPaths();
    const dbPath = `${dataDir}/panel.sqlite`;
    const raw = fs.readFileSync(dbPath);

    expect(raw.includes(Buffer.from(secret))).toBe(false);
    expect(raw.includes(Buffer.from("[REDACTED]"))).toBe(true);
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
