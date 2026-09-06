import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// ─── Part A: pure redact/rehydrate functions, isolated ────────────────────
// Mocked utils/paths.js so these never touch whatever dataDir the suite's
// globalSetup (or a live developer session) currently points at — same
// pattern as jwtSecret.test.js / uiSecretFile.test.js.
let tmpDir;

vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir }),
}));

const {
  rehydrateRconSecrets,
  redactRconSecretsForWrite,
  deleteServerSecret,
} = await import("../utils/serverRconSecrets.js");

describe("redactRconSecretsForWrite", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rconredact-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists a server's rconPassword to its own file and omits it from the returned clone", () => {
    const data = {
      servers: [{ id: "srv-1", name: "Main", rconPassword: "real-pw-1" }],
      settings: {},
    };

    const redacted = redactRconSecretsForWrite(data);

    expect(redacted.servers[0].rconPassword).toBeUndefined();
    expect(redacted.servers[0].name).toBe("Main"); // other fields survive
    expect(
      fs.readFileSync(
        path.join(tmpDir, "server-secrets", "srv-1.secret"),
        "utf8",
      ),
    ).toBe("real-pw-1");
  });

  it("does NOT mutate the original in-memory object — every other reader in the codebase must keep seeing rconPassword", () => {
    const data = {
      servers: [{ id: "srv-1", rconPassword: "real-pw-1" }],
      settings: {},
    };
    redactRconSecretsForWrite(data);
    expect(data.servers[0].rconPassword).toBe("real-pw-1");
  });

  it("a server with no rconPassword is left alone, no file created", () => {
    const data = { servers: [{ id: "srv-2", name: "No password yet" }], settings: {} };
    const redacted = redactRconSecretsForWrite(data);
    expect(redacted.servers[0]).toEqual(data.servers[0]);
    expect(
      fs.existsSync(path.join(tmpDir, "server-secrets", "srv-2.secret")),
    ).toBe(false);
  });

  it("settings.rconPassword (the legacy global mirror) is persisted and omitted the same way", () => {
    const data = { servers: [], settings: { rconPassword: "legacy-global-pw" } };
    const redacted = redactRconSecretsForWrite(data);
    expect(redacted.settings.rconPassword).toBeUndefined();
    expect(fs.readFileSync(path.join(tmpDir, "rconPassword.secret"), "utf8")).toBe(
      "legacy-global-pw",
    );
  });

  it("writing the SAME value again does not rewrite the file (steady-state flush churn)", () => {
    const data = { servers: [{ id: "srv-3", rconPassword: "stable-pw" }], settings: {} };
    redactRconSecretsForWrite(data);
    const filePath = path.join(tmpDir, "server-secrets", "srv-3.secret");
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    redactRconSecretsForWrite(data); // same value, called again

    expect(fs.statSync(filePath).mtimeMs).toBe(mtimeBefore);
  });

  // regression (apps/panel-server/utils sweep): the truthy check this used
  // to be (`if (server.rconPassword)`) treated an operator clearing the
  // password via PUT /servers/:id -- which persists an explicit "" the
  // same as any other value -- identically to the field never having been
  // touched at all. writeServerSecret(), the only thing that ever deletes
  // the sibling .secret file, was never called, so the stale file survived
  // and rehydrateRconSecrets() read the OLD password back in on the very
  // next load. See the round-trip describe block below for the full
  // restart-survives-a-clear scenario this enables.
  it("clearing rconPassword to '' deletes the sibling secret file instead of leaving it orphaned", () => {
    const data = {
      servers: [{ id: "srv-4", rconPassword: "will-be-cleared" }],
      settings: {},
    };
    redactRconSecretsForWrite(data);
    const filePath = path.join(tmpDir, "server-secrets", "srv-4.secret");
    expect(fs.existsSync(filePath)).toBe(true);

    redactRconSecretsForWrite({
      servers: [{ id: "srv-4", rconPassword: "" }],
      settings: {},
    });

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("clearing settings.rconPassword (legacy mirror) to '' deletes its secret file too, same bug, same fix", () => {
    redactRconSecretsForWrite({
      servers: [],
      settings: { rconPassword: "will-be-cleared" },
    });
    const filePath = path.join(tmpDir, "rconPassword.secret");
    expect(fs.existsSync(filePath)).toBe(true);

    redactRconSecretsForWrite({ servers: [], settings: { rconPassword: "" } });

    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe("rehydrateRconSecrets", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rconrehydrate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fills in a server's rconPassword from its sibling file when the in-memory value is missing", () => {
    fs.mkdirSync(path.join(tmpDir, "server-secrets"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "server-secrets", "srv-1.secret"),
      "recovered-pw",
    );
    const data = { servers: [{ id: "srv-1", name: "Main" }], settings: {} };

    const result = rehydrateRconSecrets(data);

    expect(result.servers[0].rconPassword).toBe("recovered-pw");
  });

  it("leaves an already-present value alone (pre-upgrade db.json, not yet through a write cycle)", () => {
    const data = {
      servers: [{ id: "srv-1", rconPassword: "still-in-db-json" }],
      settings: {},
    };
    const result = rehydrateRconSecrets(data);
    expect(result.servers[0].rconPassword).toBe("still-in-db-json");
  });

  it("a server with neither an in-memory value nor a file stays unconfigured", () => {
    const data = { servers: [{ id: "srv-never-configured" }], settings: {} };
    const result = rehydrateRconSecrets(data);
    expect(result.servers[0].rconPassword).toBeUndefined();
  });

  it("rehydrates settings.rconPassword (legacy mirror) from its own file", () => {
    fs.writeFileSync(path.join(tmpDir, "rconPassword.secret"), "recovered-legacy-pw");
    const data = { servers: [], settings: {} };
    const result = rehydrateRconSecrets(data);
    expect(result.settings.rconPassword).toBe("recovered-legacy-pw");
  });
});

describe("redact -> rehydrate round trip (simulates a full restart)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rconroundtrip-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a value written by one 'process' (redact) is recovered correctly by a fresh plain object standing in for the next boot (rehydrate)", () => {
    const beforeRestart = {
      servers: [{ id: "srv-1", name: "Main", rconPassword: "survives-a-restart" }],
      settings: {},
    };
    redactRconSecretsForWrite(beforeRestart); // what actually lands on disk

    // A brand-new plain object stands in for "freshly parsed from db.json
    // after a restart" — note it has NO rconPassword, exactly like the real
    // on-disk JSON after redaction.
    const afterRestart = {
      servers: [{ id: "srv-1", name: "Main" }],
      settings: {},
    };
    const rehydrated = rehydrateRconSecrets(afterRestart);

    expect(rehydrated.servers[0].rconPassword).toBe("survives-a-restart");
  });

  // regression: the scenario the two "clearing to ''" tests above
  // exist to prevent, run end to end the way an operator would actually hit
  // it -- set a password, restart (persists it), clear it, restart again.
  // Pre-fix this failed at the last line: rconPassword came back as
  // "original-password", the exact silent-clear-doesn't-stick defect.
  it("a cleared password does not come back on the NEXT restart after that", () => {
    const beforeFirstRestart = {
      servers: [{ id: "srv-1", rconPassword: "original-password" }],
      settings: {},
    };
    redactRconSecretsForWrite(beforeFirstRestart);

    // Operator clears it via PUT /servers/:id sometime after the first restart.
    const beforeSecondRestart = {
      servers: [{ id: "srv-1", rconPassword: "" }],
      settings: {},
    };
    redactRconSecretsForWrite(beforeSecondRestart);

    const afterSecondRestart = rehydrateRconSecrets({
      servers: [{ id: "srv-1" }],
      settings: {},
    });

    expect(afterSecondRestart.servers[0].rconPassword).toBeUndefined();
  });
});

describe("deleteServerSecret", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rcondelete-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes a server's password file so it doesn't outlive the deleted server record", () => {
    redactRconSecretsForWrite({
      servers: [{ id: "srv-doomed", rconPassword: "pw" }],
      settings: {},
    });
    const filePath = path.join(tmpDir, "server-secrets", "srv-doomed.secret");
    expect(fs.existsSync(filePath)).toBe(true);

    deleteServerSecret("srv-doomed");

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("is a silent no-op for a server id with no file", () => {
    expect(() => deleteServerSecret("never-existed")).not.toThrow();
  });
});
