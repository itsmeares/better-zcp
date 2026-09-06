import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  TEMPLATE_SCHEMA_VERSION,
  createTemplate,
  validateTemplate,
  diffTemplate,
} from "../utils/templateSchema.js";

// In-memory fake for the user_templates collection — mirrors how
// database/init.js's saveUserTemplate/getUserTemplate/deleteUserTemplate
// behave, without touching real db.json.
let userTemplates;

vi.mock("../database/init.js", () => ({
  getServer: vi.fn(),
  getSetting: vi.fn(async () => []),
  setSetting: vi.fn(async () => {}),
  getUserTemplates: vi.fn(async () => userTemplates),
  getUserTemplate: vi.fn(async (id) => userTemplates.find((t) => t.meta?.id === id) || null),
  saveUserTemplate: vi.fn(async (template) => {
    const index = userTemplates.findIndex((t) => t.meta?.id === template.meta?.id);
    if (index === -1) userTemplates.push(template);
    else userTemplates[index] = template;
    return template;
  }),
  deleteUserTemplate: vi.fn(async (id) => {
    const before = userTemplates.length;
    userTemplates = userTemplates.filter((t) => t.meta?.id !== id);
    return userTemplates.length < before;
  }),
}));

const { getServer, getSetting, setSetting } = await import("../database/init.js");
const templateService = await import("../services/templateService.js");

const BUILTIN_IDS = [
  "vanilla-apocalypse",
  "first-week-friendly",
  "hardcore-survivor",
  "pvp-raiding",
  "builders-paradise",
  "six-months-later",
];

beforeEach(() => {
  userTemplates = [];
  getServer.mockReset();
  getSetting.mockReset();
  getSetting.mockResolvedValue([]);
  setSetting.mockReset();
});

// ─── templateSchema.js ──────────────────────────────────────────────────────

describe("createTemplate", () => {
  it("fills in defaults and generates a unique id", () => {
    const a = createTemplate({ name: "A" });
    const b = createTemplate({ name: "B" });

    expect(a.schemaVersion).toBe(TEMPLATE_SCHEMA_VERSION);
    expect(a.meta.name).toBe("A");
    expect(a.meta.id).toBeTruthy();
    expect(a.meta.id).not.toBe(b.meta.id);
    expect(a.map).toEqual({ mapId: "Muldraugh, KY" });
    expect(a.iniExclusions).toContain("RCONPassword");
    expect(a.sandboxVars).toEqual({});
    expect(a.serverIni).toEqual({});
  });
});

describe("validateTemplate", () => {
  it("accepts a well-formed template", () => {
    const template = createTemplate({
      name: "Test",
      sandboxVars: { settings: { Zombies: 5 }, ZombieLore: { Speed: 1 } },
      serverIni: { PauseEmpty: true },
    });
    expect(validateTemplate(template)).toEqual({ valid: true, errors: [] });
  });

  it("rejects a missing name", () => {
    const template = createTemplate({});
    const { valid, errors } = validateTemplate(template);
    expect(valid).toBe(false);
    expect(errors.join(" ")).toMatch(/meta.name/);
  });

  it("rejects an unknown sandbox section", () => {
    const template = createTemplate({ name: "X", sandboxVars: { NotASection: { Foo: 1 } } });
    const { valid, errors } = validateTemplate(template);
    expect(valid).toBe(false);
    expect(errors.join(" ")).toMatch(/NotASection/);
  });

  it("rejects a non-primitive sandbox value", () => {
    const template = createTemplate({ name: "X", sandboxVars: { settings: { Bad: { nested: 1 } } } });
    expect(validateTemplate(template).valid).toBe(false);
  });

  it("rejects serverIni keys that are supposed to be excluded", () => {
    const template = createTemplate({ name: "X", serverIni: { RCONPassword: "leak" } });
    const { valid, errors } = validateTemplate(template);
    expect(valid).toBe(false);
    expect(errors.join(" ")).toMatch(/RCONPassword/);
  });

  // 2026-08-24 conv-template-privesc: validateTemplate used to read
  // template.iniExclusions AS the exclusion list rather than adding it to
  // DEFAULT_INI_EXCLUSIONS, so a template supplying its own empty list
  // disabled the leaked-key check entirely and validated clean with
  // RCONPassword sitting right in serverIni.
  it("rejects a template that supplies its own empty iniExclusions to try to disable the check", () => {
    const template = {
      ...createTemplate({ name: "Privesc attempt" }),
      iniExclusions: [],
      serverIni: { RCONPassword: "leak" },
    };
    const { valid, errors } = validateTemplate(template);
    expect(valid).toBe(false);
    expect(errors.join(" ")).toMatch(/RCONPassword/);
  });

  it("rejects a template that supplies its own empty iniExclusions with every default-excluded key leaked in", () => {
    const template = {
      ...createTemplate({ name: "Privesc attempt 2" }),
      iniExclusions: [],
      serverIni: {
        RCONPassword: "leak",
        Password: "leak",
        ServerName: "leak",
        PublicName: "leak",
        DefaultPort: 1,
        UDPPort: 1,
        RCONPort: 1,
        server_browser_announced_ip: "leak",
      },
    };
    const { valid, errors } = validateTemplate(template);
    expect(valid).toBe(false);
    for (const key of [
      "RCONPassword",
      "Password",
      "ServerName",
      "PublicName",
      "DefaultPort",
      "UDPPort",
      "RCONPort",
      "server_browser_announced_ip",
    ]) {
      expect(errors.join(" ")).toMatch(new RegExp(key));
    }
  });
});

describe("diffTemplate", () => {
  it("reports only keys that differ from the current config", () => {
    const template = createTemplate({
      name: "X",
      serverIni: { PauseEmpty: true, PVP: true },
      sandboxVars: { settings: { Zombies: 5 } },
    });
    const currentConfig = {
      serverIni: { PauseEmpty: "false", PVP: "true" },
      sandboxVars: { settings: { Zombies: 4 } },
    };

    const diff = diffTemplate(template, currentConfig);
    expect(diff.serverIni).toEqual([{ key: "PauseEmpty", from: "false", to: true }]);
    expect(diff.sandboxVars).toEqual([
      { section: "settings", key: "Zombies", from: 4, to: 5 },
    ]);
    expect(diff.summary).toEqual({ iniChanges: 1, sandboxChanges: 1, totalChanges: 2 });
  });

  it("never surfaces excluded ini keys even if present in the template", () => {
    const template = {
      ...createTemplate({ name: "X" }),
      serverIni: { RCONPassword: "leak" }, // bypassing validateTemplate on purpose
    };
    const diff = diffTemplate(template, { serverIni: {} });
    expect(diff.serverIni).toEqual([]);
  });

  it("treats a missing current value as a change", () => {
    const template = createTemplate({ name: "X", serverIni: { PauseEmpty: true } });
    const diff = diffTemplate(template, { serverIni: {} });
    expect(diff.serverIni).toEqual([{ key: "PauseEmpty", from: undefined, to: true }]);
  });
});

// ─── Built-in templates ──────────────────────────────────────────────────────

describe("built-in templates", () => {
  it("load every catalog template and each one validates", async () => {
    const templates = await templateService.listTemplates();
    const builtinIds = templates.filter((t) => t.isBuiltin).map((t) => t.meta.id);

    for (const id of BUILTIN_IDS) {
      expect(builtinIds).toContain(id);
    }
    for (const template of templates.filter((t) => t.isBuiltin)) {
      const { valid, errors } = validateTemplate(template);
      expect(valid, `${template.meta.id}: ${errors.join(", ")}`).toBe(true);
    }
  });

  it("getTemplate resolves a built-in by id", async () => {
    const template = await templateService.getTemplate("hardcore-survivor");
    expect(template?.meta.name).toBe("Hardcore Survivor");
    expect(template?.isBuiltin).toBe(true);
  });

  it("hides a built-in template for this panel", async () => {
    const result = await templateService.deleteTemplate("vanilla-apocalypse");
    expect(result).toEqual({ success: true, hiddenBuiltin: true });
    expect(setSetting).toHaveBeenCalledWith(
      "hiddenBuiltinTemplateIds",
      ["vanilla-apocalypse"],
    );
  });

  it("does not list a hidden built-in template", async () => {
    getSetting.mockResolvedValue(["vanilla-apocalypse"]);

    const templates = await templateService.listTemplates();

    expect(templates.map((template) => template.meta.id)).not.toContain("vanilla-apocalypse");
  });

  // 2026-08-31 bug hunt (templates-builtin-hidden-with-no-restore-path):
  // deleteTemplate's hide path (above) only ever added an id to the
  // setting -- nothing ever read the list back out, so a hidden built-in
  // was invisible everywhere: listTemplates filtered it out, getTemplate
  // returned null for it, and the operator had no way to even learn its
  // id, let alone restore it. listHiddenBuiltinTemplates/unhideTemplate are
  // the other half of the round trip.
  it("listHiddenBuiltinTemplates returns nothing when nothing is hidden", async () => {
    const hidden = await templateService.listHiddenBuiltinTemplates();
    expect(hidden).toEqual([]);
  });

  it("listHiddenBuiltinTemplates surfaces a hidden built-in's real data, not just its id", async () => {
    getSetting.mockResolvedValue(["vanilla-apocalypse"]);

    const hidden = await templateService.listHiddenBuiltinTemplates();

    expect(hidden).toHaveLength(1);
    expect(hidden[0].meta.id).toBe("vanilla-apocalypse");
    expect(hidden[0].isBuiltin).toBe(true);
    // Not present in the normal list at the same time.
    const visible = await templateService.listTemplates();
    expect(visible.map((t) => t.meta.id)).not.toContain("vanilla-apocalypse");
  });

  it("unhideTemplate restores a hidden built-in to the normal list", async () => {
    getSetting.mockResolvedValue(["vanilla-apocalypse", "pvp-raiding"]);

    const result = await templateService.unhideTemplate("vanilla-apocalypse");

    expect(result).toEqual({ success: true });
    // Only the target id is removed -- the other hidden one stays hidden.
    expect(setSetting).toHaveBeenCalledWith("hiddenBuiltinTemplateIds", ["pvp-raiding"]);
  });

  it("unhideTemplate reports an error for an id that isn't actually hidden", async () => {
    getSetting.mockResolvedValue([]);

    const result = await templateService.unhideTemplate("vanilla-apocalypse");

    expect(result.success).toBe(false);
  });

  it("refuses to save over a built-in template id", async () => {
    const result = await templateService.saveTemplate({
      schemaVersion: TEMPLATE_SCHEMA_VERSION,
      meta: { id: "hardcore-survivor", name: "Hijacked" },
      serverIni: {},
      sandboxVars: {},
    });
    expect(result.success).toBe(false);
    expect(userTemplates).toHaveLength(0);
  });
});

// ─── User template CRUD ──────────────────────────────────────────────────────

describe("saveTemplate / deleteTemplate for user templates", () => {
  it("creates a new user template from scratch", async () => {
    const result = await templateService.saveTemplate({
      name: "My Ruleset",
      sandboxVars: { settings: { Zombies: 3 } },
    });
    expect(result.success).toBe(true);
    expect(result.template.meta.name).toBe("My Ruleset");
    expect(userTemplates).toHaveLength(1);
  });

  it("rejects an invalid template", async () => {
    const result = await templateService.saveTemplate({ name: "" });
    expect(result.success).toBe(false);
    expect(userTemplates).toHaveLength(0);
  });

  it("deletes an existing user template", async () => {
    const created = await templateService.saveTemplate({ name: "Deletable" });
    const result = await templateService.deleteTemplate(created.template.meta.id);
    expect(result).toEqual({ success: true });
    expect(userTemplates).toHaveLength(0);
  });

  it("reports an error deleting a template that doesn't exist", async () => {
    const result = await templateService.deleteTemplate("does-not-exist");
    expect(result.success).toBe(false);
  });
});

// ─── Import / export round-trip ─────────────────────────────────────────────

describe("import/export round trip", () => {
  it("exports a built-in template and re-imports it as a new user template", async () => {
    const exported = await templateService.exportTemplate("first-week-friendly");
    expect(exported.success).toBe(true);
    expect(exported.template.isBuiltin).toBeUndefined();

    const imported = await templateService.importTemplate(exported.template);
    expect(imported.success).toBe(true);
    expect(imported.template.meta.id).not.toBe("first-week-friendly");
    expect(imported.template.meta.name).toBe("First Week Friendly");
    expect(imported.template.sandboxVars).toEqual(exported.template.sandboxVars);
    expect(userTemplates).toHaveLength(1);
  });

  it("rejects importing a template with excluded ini keys leaked in", async () => {
    const badTemplate = {
      ...createTemplate({ name: "Bad Import" }),
      serverIni: { RCONPassword: "leak" },
    };
    const result = await templateService.importTemplate(badTemplate);
    expect(result.success).toBe(false);
    expect(userTemplates).toHaveLength(0);
  });

  it("exporting an unknown template fails", async () => {
    const result = await templateService.exportTemplate("nope");
    expect(result.success).toBe(false);
  });
});

// ─── Preview / apply against a server's config files ────────────────────────

describe("previewTemplate / applyTemplate", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-template-apply-"));
    fs.writeFileSync(
      path.join(dir, "TestServer.ini"),
      "PauseEmpty=false\nPVP=true\n",
    );
    fs.writeFileSync(
      path.join(dir, "TestServer_SandboxVars.lua"),
      [
        "SandboxVars = {",
        "    VERSION = 4,",
        "    Zombies = 4,",
        "    HoursForLootRespawn = 0,",
        "    ZombieLore = {",
        "        Mortality = 5,",
        "    },",
        "    ZombieConfig = {",
        "        PopulationMultiplier = 0.65,",
        "    },",
        "    MultiplierConfig = {",
        "        Global = 1.0,",
        "    },",
        "}",
        "",
      ].join("\n"),
    );
    getServer.mockResolvedValue({
      id: "server-1",
      serverName: "TestServer",
      serverConfigPath: dir,
      isRemote: false,
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("previewTemplate reports the changes applying would make", async () => {
    const result = await templateService.previewTemplate("first-week-friendly", "server-1");
    expect(result.success).toBe(true);
    expect(result.diff.serverIni).toEqual(
      expect.arrayContaining([{ key: "PauseEmpty", from: "false", to: true }]),
    );
    expect(result.diff.sandboxVars).toEqual(
      expect.arrayContaining([
        { section: "settings", key: "Zombies", from: 4, to: 5 },
      ]),
    );
  });

  it("applyTemplate writes ini and sandbox changes and creates backups", async () => {
    const result = await templateService.applyTemplate("first-week-friendly", "server-1");

    expect(result.success).toBe(true);
    expect(result.backups.length).toBeGreaterThan(0);

    const ini = fs.readFileSync(path.join(dir, "TestServer.ini"), "utf-8");
    expect(ini).toContain("PauseEmpty=true");

    const lua = fs.readFileSync(path.join(dir, "TestServer_SandboxVars.lua"), "utf-8");
    expect(lua).toContain("Zombies = 5");
    expect(lua).toContain("Global = 2");

    const backupsDir = path.join(dir, "backups");
    expect(fs.readdirSync(backupsDir).length).toBeGreaterThan(0);
  });

  it("applyTemplate skips the ini section when options.applyIni is false", async () => {
    const result = await templateService.applyTemplate("first-week-friendly", "server-1", {
      applyIni: false,
    });

    expect(result.success).toBe(true);
    expect(result.ini).toBeNull();
    const ini = fs.readFileSync(path.join(dir, "TestServer.ini"), "utf-8");
    expect(ini).toContain("PauseEmpty=false");

    const lua = fs.readFileSync(path.join(dir, "TestServer_SandboxVars.lua"), "utf-8");
    expect(lua).toContain("Zombies = 5");
  });

  it("applyTemplate skips the sandbox section when options.applySandbox is false", async () => {
    const result = await templateService.applyTemplate("first-week-friendly", "server-1", {
      applySandbox: false,
    });

    expect(result.success).toBe(true);
    expect(result.sandbox).toBeNull();
    const lua = fs.readFileSync(path.join(dir, "TestServer_SandboxVars.lua"), "utf-8");
    expect(lua).toContain("Zombies = 4");

    const ini = fs.readFileSync(path.join(dir, "TestServer.ini"), "utf-8");
    expect(ini).toContain("PauseEmpty=true");
  });

  it("applyTemplate never writes an excluded ini key even if one slipped into a stored template", async () => {
    // Simulate a template that bypassed validateTemplate (e.g. a hand-edited
    // db.json) to prove applyTemplate defends against this independently.
    // The ini fixture must already CONTAIN RCONPassword before applying --
    // prepareIniChange only ever updates a key already present in the file
    // (mergeIniValues can append a new key, but prepareIniChange's own
    // `updates` filter never passes it one to append), so a fixture without
    // a pre-existing RCONPassword line would pass this assertion even with
    // the exclusion filter completely broken, proving nothing.
    fs.writeFileSync(
      path.join(dir, "TestServer.ini"),
      "PauseEmpty=false\nPVP=true\nRCONPassword=original-secret\n",
    );
    userTemplates.push({
      ...createTemplate({ name: "Malicious" }),
      meta: { ...createTemplate({ name: "Malicious" }).meta, id: "malicious" },
      serverIni: { RCONPassword: "leak", PauseEmpty: true },
    });

    await templateService.applyTemplate("malicious", "server-1");

    const ini = fs.readFileSync(path.join(dir, "TestServer.ini"), "utf-8");
    expect(ini).toContain("RCONPassword=original-secret");
    expect(ini).not.toContain("leak");
    expect(ini).toContain("PauseEmpty=true");
  });

  // 2026-08-24 conv-template-privesc: the apply-time write path
  // (prepareIniChange) had its OWN independent read of iniExclusions
  // (`template.iniExclusions || DEFAULT_INI_EXCLUSIONS`) -- a second,
  // separately-broken copy of the same mistake validateTemplate made. `[]`
  // is truthy, so `||` never fell back to the default either. Proving
  // validateTemplate rejects this (see the validateTemplate suite above)
  // does NOT prove this layer defends independently -- both sites made the
  // same mistake on their own, so both need their own test, each with a
  // pre-existing value in the fixture ini for the same reason as the test
  // above.
  it("applyTemplate never writes an excluded ini key even when the stored template supplies its own empty iniExclusions", async () => {
    fs.writeFileSync(
      path.join(dir, "TestServer.ini"),
      "PauseEmpty=false\nPVP=true\nRCONPassword=original-secret\nRCONPort=27015\n",
    );
    userTemplates.push({
      ...createTemplate({ name: "Privesc via stored template" }),
      meta: { ...createTemplate({ name: "Privesc via stored template" }).meta, id: "privesc" },
      iniExclusions: [],
      serverIni: { RCONPassword: "leak", RCONPort: "9999", PauseEmpty: true },
    });

    await templateService.applyTemplate("privesc", "server-1");

    const ini = fs.readFileSync(path.join(dir, "TestServer.ini"), "utf-8");
    expect(ini).toContain("RCONPassword=original-secret");
    expect(ini).toContain("RCONPort=27015");
    expect(ini).not.toContain("leak");
    expect(ini).not.toContain("9999");
    expect(ini).toContain("PauseEmpty=true");
  });

  it("skips unknown INI keys instead of appending imported settings", async () => {
    const template = createTemplate({
      name: "Unknown key",
      serverIni: { PauseEmpty: true, NotARealSetting: true },
    });
    userTemplates.push({
      ...template,
      meta: { ...template.meta, id: "unknown-key" },
    });

    const result = await templateService.applyTemplate("unknown-key", "server-1");

    expect(result.ini.skippedKeys).toEqual(["NotARealSetting"]);
    const ini = fs.readFileSync(path.join(dir, "TestServer.ini"), "utf-8");
    expect(ini).toContain("PauseEmpty=true");
    expect(ini).not.toContain("NotARealSetting");
  });

  it("rejects a traversing server name before constructing config paths", async () => {
    getServer.mockResolvedValue({
      id: "server-1",
      serverName: "../outside",
      serverConfigPath: dir,
      isRemote: false,
    });

    const result = await templateService.applyTemplate(
      "first-week-friendly",
      "server-1",
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/config path/i);
  });

  it("skips the sandbox portion with a clear reason when SandboxVars.lua is missing", async () => {
    fs.unlinkSync(path.join(dir, "TestServer_SandboxVars.lua"));

    const result = await templateService.applyTemplate("first-week-friendly", "server-1");

    expect(result.success).toBe(true);
    expect(result.sandbox).toEqual({
      skipped: true,
      reason: expect.stringMatching(/SandboxVars\.lua not found/),
    });
  });

  it("refuses to apply to a remote server", async () => {
    getServer.mockResolvedValue({
      id: "server-2",
      serverName: "RemoteServer",
      serverConfigPath: dir,
      isRemote: true,
    });

    const result = await templateService.applyTemplate("first-week-friendly", "server-2");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/remote/i);
  });

  it("returns an error when the server doesn't exist", async () => {
    getServer.mockResolvedValue(null);
    const result = await templateService.applyTemplate("first-week-friendly", "missing");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
