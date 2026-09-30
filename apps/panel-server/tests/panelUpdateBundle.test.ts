import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stageUpdateBundle, applyUpdateBundle, acknowledgeUpdateBundle, recoverInterruptedUpdateBundle, readUpdateBundleJournalIfPresent } from "../services/updateBundle.ts";

let root: string;
const metadata = { panelVersion: "2.0.1", buildSha: "new-build", apiContractVersion: 1 };
function write(name: string, value: string) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; }
function prepare() {
  const binary = write("ZomboidControlPanel", "old-binary"), client = path.join(root, "client/dist"), data = path.join(root, "data");
  write("client/dist/index.html", "old-client"); write("start.sh", "old-launcher");
  write("incoming/index.html", "new-client"); write("incoming/build-info.json", JSON.stringify(metadata));
  write("data/jwt.secret", "old-secret"); write("data/server-secrets/one.json", "old-profile-secret");
  const db = new DatabaseSync(path.join(data, "panel.sqlite")); db.exec("CREATE TABLE admin (name TEXT); INSERT INTO admin VALUES ('owner');"); db.close();
  write("world/map.bin", "game-world");
  const journal = stageUpdateBundle({ installDir: root, version: metadata.panelVersion, binaryPath: binary, stagedBinaryPath: write("incoming-binary", "new-binary"), liveClientPath: client, incomingClientPath: path.join(root, "incoming"), metadata, managedFiles: { "start.sh": write("incoming-start.sh", "new-launcher") } });
  return { binary, client, data, journal };
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-bundle-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("native update transaction", () => {
  it("commits the binary, client and launcher only after a matching health acknowledgement", () => {
    const p = prepare();
    expect(fs.readFileSync(p.binary, "utf8")).toBe("old-binary");
    applyUpdateBundle(p.journal, p.data);
    expect(fs.readFileSync(p.binary, "utf8")).toBe("new-binary");
    expect(readUpdateBundleJournalIfPresent(p.journal)?.phase).toBe("awaiting_startup_ack");
    expect(acknowledgeUpdateBundle(p.journal, metadata)).toBe(true);
    expect(fs.existsSync(p.journal)).toBe(false);
    const retained = fs.readdirSync(root).find(name => name.startsWith(".panel-data-before-"))!;
    expect(fs.existsSync(path.join(root, retained, "panel.sqlite"))).toBe(true);
    expect(fs.readFileSync(path.join(root, retained, "jwt.secret"), "utf8")).toBe("old-secret");
    expect(fs.readFileSync(path.join(root, "start.sh"), "utf8")).toBe("new-launcher");
    expect(fs.readFileSync(path.join(root, "world/map.bin"), "utf8")).toBe("game-world");
  });
  it("restores a migrated SQLite database, secrets and every managed file when health fails", () => {
    const p = prepare(); applyUpdateBundle(p.journal, p.data);
    const db = new DatabaseSync(path.join(p.data, "panel.sqlite")); db.exec("UPDATE admin SET name='changed-by-new-panel';"); db.close();
    write("data/jwt.secret", "changed-secret"); write("data/server-secrets/one.json", "changed-profile-secret");
    expect(() => acknowledgeUpdateBundle(p.journal, { ...metadata, buildSha: "wrong-build" })).toThrow(/verification/);
    expect(recoverInterruptedUpdateBundle(p.journal, p.data)).toBe(true);
    const restored = new DatabaseSync(path.join(p.data, "panel.sqlite")); expect(restored.prepare("SELECT name FROM admin").get()!.name).toBe("owner"); restored.close();
    expect(fs.readFileSync(p.binary, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(p.client, "index.html"), "utf8")).toBe("old-client");
    expect(fs.readFileSync(path.join(root, "start.sh"), "utf8")).toBe("old-launcher");
    expect(fs.readFileSync(path.join(p.data, "jwt.secret"), "utf8")).toBe("old-secret");
    expect(fs.readFileSync(path.join(p.data, "server-secrets/one.json"), "utf8")).toBe("old-profile-secret");
  });
  it.each(["ZomboidControlPanel", "client/dist/index.html", "start.sh"])("refuses tampered %s before changing installed files", name => {
    const p = prepare(), journal = readUpdateBundleJournalIfPresent(p.journal)!;
    write(`.panel-update-${journal.transactionId}/${name}`, "tampered");
    expect(() => applyUpdateBundle(p.journal, p.data)).toThrow(/changed/);
    expect(fs.readFileSync(p.binary, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(p.client, "index.html"), "utf8")).toBe("old-client");
  });
  it("refuses to swap files if the mandatory data backup cannot be created", () => {
    const p = prepare(); fs.rmSync(path.join(p.data, "panel.sqlite"));
    expect(() => applyUpdateBundle(p.journal, p.data)).toThrow(/database is missing/);
    expect(fs.readFileSync(p.binary, "utf8")).toBe("old-binary");
    expect(readUpdateBundleJournalIfPresent(p.journal)?.phase).toBe("staged");
  });
  it("rolls back an interrupted swap and retains a failed rollback for retry", () => {
    const p = prepare(); const original = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => { if (String(a).includes(".panel-update-") && String(b).endsWith("start.sh")) throw new Error("swap failed"); original(a, b); });
    expect(() => applyUpdateBundle(p.journal, p.data)).toThrow(/swap failed/);
    expect(fs.readFileSync(p.binary, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(root, "start.sh"), "utf8")).toBe("old-launcher");
    expect(fs.existsSync(p.journal)).toBe(false);
  });
  it("keeps a failed rollback journal and retries without losing the old files", () => {
    const p = prepare(); applyUpdateBundle(p.journal, p.data);
    const original = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => { if (String(a).includes(".panel-previous-") && b === p.binary) throw new Error("file locked"); original(a, b); });
    expect(() => recoverInterruptedUpdateBundle(p.journal, p.data)).toThrow(/rollback failed/);
    expect(readUpdateBundleJournalIfPresent(p.journal)?.phase).toBe("rollback_failed");
    vi.restoreAllMocks(); expect(recoverInterruptedUpdateBundle(p.journal, p.data)).toBe(true);
    expect(fs.readFileSync(p.binary, "utf8")).toBe("old-binary");
  });
  it("rejects symlinks and journal paths outside the managed file list", () => {
    const p = prepare(), journal = readUpdateBundleJournalIfPresent(p.journal)!;
    journal.files[0].name = "../world/map.bin" as never;
    fs.writeFileSync(p.journal, JSON.stringify(journal));
    expect(() => applyUpdateBundle(p.journal, p.data)).toThrow(/Invalid update journal/);
    expect(fs.readFileSync(path.join(root, "world/map.bin"), "utf8")).toBe("game-world");
  });
});
