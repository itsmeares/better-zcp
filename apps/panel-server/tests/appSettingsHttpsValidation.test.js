import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const settingsStore = { panelPort: 3001 };

vi.mock("../database/init.js", () => ({
  getAllSettings: vi.fn(async () => ({ ...settingsStore })),
  getSetting: vi.fn(async (key) => settingsStore[key]),
  setSetting: vi.fn(async (key, value) => {
    settingsStore[key] = value;
  }),
  getRoleByName: vi.fn(async (name) =>
    name === "admin"
      ? {
          capabilities: [
            "panel.settings",
            "server.configure",
            "server.install",
            "bridge.setup",
            "integrations.manage",
            "mods.manage",
          ],
        }
      : null,
  ),
}));

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function putAppSettings(settings) {
  const { default: router } = await import("../routes/config.ts");
  const res = createResponse();
  await getRouteHandler(router, "/app-settings", "put")(
    {
      body: { settings },
      user: { role: "admin" },
      app: { get: () => undefined },
    },
    res,
  );
  return res;
}

let tempDir;

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
  settingsStore.panelPort = 3001;
  delete settingsStore.httpsPort;
});

describe("PUT /app-settings -- httpsCertPath / httpsKeyPath validation (HTTPS enabled)", () => {
  it("rejects a directory as httpsCertPath instead of saving it", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-appsettings-test-"));
    const res = await putAppSettings({ httpsEnabled: true, httpsCertPath: tempDir });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/must be a file, not a directory/);
  });

  it("rejects a path that doesn't exist", async () => {
    const res = await putAppSettings({
      httpsEnabled: true,
      httpsKeyPath: "C:\\nonexistent\\path\\key.pem",
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/does not point to a file that exists/);
  });

  it("accepts an empty string even while enabled -- clearing the custom cert path back to auto-generated must still work", async () => {
    const res = await putAppSettings({ httpsEnabled: true, httpsCertPath: "" });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("accepts a real, readable file", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-appsettings-test-"));
    const certPath = path.join(tempDir, "panel.cert");
    fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n");
    const res = await putAppSettings({ httpsEnabled: true, httpsCertPath: certPath });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("does not block an unrelated save over a stale/garbage httpsCertPath while HTTPS is disabled", async () => {
    const res = await putAppSettings({
      httpsEnabled: false,
      httpsCertPath: "C:\\this\\file\\was\\deleted\\ages\\ago.cert",
      darkMode: true,
    });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- httpsPort validation (HTTPS enabled, bind-port range joined to BIND_PORT_MIN/MAX)", () => {
  it("rejects a non-integer value", async () => {
    const res = await putAppSettings({ httpsEnabled: true, httpsPort: "not-a-number" });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/HTTPS port must be a whole number/);
  });

  it.each(["1e2", " "])("rejects non-decimal whole-number input %j", async (value) => {
    const res = await putAppSettings({ httpsEnabled: true, httpsPort: value });
    expect(res.getStatusCode()).toBe(400);
  });

  it("rejects an out-of-range value", async () => {
    const res = await putAppSettings({ httpsEnabled: true, httpsPort: 999999 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/HTTPS port must be a whole number/);
  });

  it("rejects a port below the 1024 bind floor, zero, and negative values", async () => {
    const belowFloor = await putAppSettings({ httpsEnabled: true, httpsPort: 443 });
    expect(belowFloor.getStatusCode()).toBe(400);
    const zero = await putAppSettings({ httpsEnabled: true, httpsPort: 0 });
    expect(zero.getStatusCode()).toBe(400);
    const negative = await putAppSettings({ httpsEnabled: true, httpsPort: -443 });
    expect(negative.getStatusCode()).toBe(400);
  });

  it("rejects a port equal to the panel's own HTTP port", async () => {
    settingsStore.panelPort = 3001;
    const res = await putAppSettings({ httpsEnabled: true, httpsPort: 3001 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/cannot be the same as the panel's HTTP port/);
  });

  it("accepts a valid, non-colliding port", async () => {
    settingsStore.panelPort = 3001;
    const res = await putAppSettings({ httpsEnabled: true, httpsPort: 3443 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("does not block an unrelated save over an out-of-range httpsPort while HTTPS is disabled", async () => {
    const res = await putAppSettings({ httpsEnabled: false, httpsPort: 0, darkMode: true });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- reconnectInterval validation (same missing-range-check shape, lower stakes; autoReconnect enabled)", () => {
  it("rejects an out-of-range value", async () => {
    const tooLow = await putAppSettings({ autoReconnect: true, reconnectInterval: 0 });
    expect(tooLow.getStatusCode()).toBe(400);
    const tooHigh = await putAppSettings({ autoReconnect: true, reconnectInterval: 61 });
    expect(tooHigh.getStatusCode()).toBe(400);
  });

  it("rejects scientific notation instead of coercing it", async () => {
    const res = await putAppSettings({ autoReconnect: true, reconnectInterval: "1e1" });
    expect(res.getStatusCode()).toBe(400);
  });

  it("accepts a valid value", async () => {
    const res = await putAppSettings({ autoReconnect: true, reconnectInterval: 15 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- feature-gated fields (FEATURE_GATED_FIELDS), table-driven", () => {
  const cases = [
    ["panelBridgeSftpEnabled", "panelBridgeSftpPort", 0, /SFTP port must be a whole number/],
    ["panelBridgeSftpEnabled", "panelBridgeSftpPollIntervalSeconds", 1, /SFTP sync interval/],
    ["httpsEnabled", "httpsPort", 0, /HTTPS port must be a whole number/],
    ["modAutoRestart", "modRestartDelay", -1, /Mod restart delay/],
    ["serverAutoUpdate", "serverAutoUpdateWarningMinutes", 61, /Server auto-update warning/],
    ["autoExportOnLogin", "autoExportMaxPerPlayer", 500, /Auto-export copies kept/],
    ["autoReconnect", "reconnectInterval", 0, /reconnectInterval must be a whole number/],
  ];

  it.each(cases)(
    "skips validating %s's %s (garbage value %j) while the flag is off in this same save",
    async (flagKey, fieldKey, garbageValue) => {
      const res = await putAppSettings({ [flagKey]: false, [fieldKey]: garbageValue });
      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody().success).toBe(true);
    },
  );

  it.each(cases)(
    "still validates %s's %s when THIS save is what turns the flag on (ordering: reads the payload, not stale stored state)",
    async (flagKey, fieldKey, garbageValue, errorPattern) => {
      const res = await putAppSettings({ [flagKey]: true, [fieldKey]: garbageValue });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().error).toMatch(errorPattern);
    },
  );
});

describe("PUT /app-settings -- panelPort validation (the lockout case, not the mild one)", () => {
  it("rejects a non-integer value", async () => {
    const res = await putAppSettings({ panelPort: "not-a-number" });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Panel port must be a whole number/);
  });

  it("rejects an out-of-range value instead of saving it silently", async () => {
    const res = await putAppSettings({ panelPort: 80 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Panel port must be a whole number/);
  });

  it("rejects a value below 1024 (matches auth.js /setup's reserved-range floor for this field)", async () => {
    const res = await putAppSettings({ panelPort: 1023 });
    expect(res.getStatusCode()).toBe(400);
  });

  it("rejects a value above 65535", async () => {
    const res = await putAppSettings({ panelPort: 65536 });
    expect(res.getStatusCode()).toBe(400);
  });

  it("accepts a valid port", async () => {
    const res = await putAppSettings({ panelPort: 3001 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- panelPort/httpsPort collision is bidirectional", () => {
  it("rejects a panelPort equal to the stored httpsPort", async () => {
    settingsStore.httpsPort = 8443;
    const res = await putAppSettings({ panelPort: 8443 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/cannot be the same as the panel's HTTPS port/);
  });

  it("accepts a panelPort that doesn't collide with the stored httpsPort", async () => {
    settingsStore.httpsPort = 8443;
    const res = await putAppSettings({ panelPort: 3001 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("accepts a panelPort when no httpsPort is configured yet", async () => {
    const res = await putAppSettings({ panelPort: 3001 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- the second door onto server.js's four hardened fields", () => {
  it("rejects an out-of-range rconPort", async () => {
    const res = await putAppSettings({ rconPort: 99 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/RCON port must be a whole number/);
  });

  it("accepts a valid rconPort", async () => {
    const res = await putAppSettings({ rconPort: 27015 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects an out-of-range serverPort", async () => {
    const res = await putAppSettings({ serverPort: 80 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Game port must be a whole number/);
  });

  it("accepts a valid serverPort", async () => {
    const res = await putAppSettings({ serverPort: 16261 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects an over-cap minMemory", async () => {
    const res = await putAppSettings({ minMemory: 256 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Minimum memory \(GB\) must be a whole number/);
  });

  it("accepts a valid minMemory", async () => {
    const res = await putAppSettings({ minMemory: 4 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects an over-cap maxMemory", async () => {
    const res = await putAppSettings({ maxMemory: 9999 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Maximum memory \(GB\) must be a whole number/);
  });

  it("accepts a valid maxMemory", async () => {
    const res = await putAppSettings({ maxMemory: 8 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- autoExportMaxPerPlayer validation (low priority, self-heals at use; autoExportOnLogin enabled)", () => {
  it("rejects an out-of-range value instead of storing garbage", async () => {
    const res = await putAppSettings({ autoExportOnLogin: true, autoExportMaxPerPlayer: 500 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Auto-export copies kept must be a whole number/);
  });

  it("accepts a valid value", async () => {
    const res = await putAppSettings({ autoExportOnLogin: true, autoExportMaxPerPlayer: 3 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- the other 8 boolean settings now reject a non-boolean value", () => {
  const booleanKeys = [
    "modAutoRestart",
    "serverAutoUpdate",
    "darkMode",
    "autoReconnect",
    "httpsEnabled",
    "autoStartServer",
    "workshopCollectionAutoSync",
    "panelBridgeSftpEnabled",
  ];

  for (const key of booleanKeys) {
    it(`rejects a non-boolean value for ${key}`, async () => {
      const res = await putAppSettings({ [key]: "yes" });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().error).toBe(`${key} must be true or false`);
    });

    it(`accepts a real boolean for ${key}`, async () => {
      const res = await putAppSettings({ [key]: true });
      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody().success).toBe(true);
    });
  }
});

describe("PUT /app-settings -- modRestartDelay validation (bound chased, service is the authority; modAutoRestart enabled)", () => {
  it("accepts zero -- the service's own floor, even though Settings.tsx's UI recommends min=1", async () => {
    const res = await putAppSettings({ modAutoRestart: true, modRestartDelay: 0 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects a negative value", async () => {
    const res = await putAppSettings({ modAutoRestart: true, modRestartDelay: -1 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Mod restart delay \(minutes\) must be a whole number/);
  });

  it("rejects a value above 30", async () => {
    const res = await putAppSettings({ modAutoRestart: true, modRestartDelay: 31 });
    expect(res.getStatusCode()).toBe(400);
  });

  it("accepts a valid value", async () => {
    const res = await putAppSettings({ modAutoRestart: true, modRestartDelay: 5 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- serverAutoUpdateWarningMinutes validation (bound chased, matches client exactly; serverAutoUpdate enabled)", () => {
  it("accepts zero (a real, meaningful choice here: restart with no warning)", async () => {
    const res = await putAppSettings({ serverAutoUpdate: true, serverAutoUpdateWarningMinutes: 0 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects a value above 60", async () => {
    const res = await putAppSettings({ serverAutoUpdate: true, serverAutoUpdateWarningMinutes: 61 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Server auto-update warning \(minutes\) must be a whole number/);
  });

  it("accepts a valid value", async () => {
    const res = await putAppSettings({ serverAutoUpdate: true, serverAutoUpdateWarningMinutes: 15 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- SFTP numeric settings validation", () => {
  it("rejects an explicit zero SFTP port while SFTP is enabled", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: true, panelBridgeSftpPort: 0 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/SFTP port must be a whole number/);
  });

  it("rejects a prefixed SFTP port instead of truncating it, while SFTP is enabled", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: true, panelBridgeSftpPort: "22junk" });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/SFTP port must be a whole number/);
  });

  it("rejects an out-of-range SFTP polling interval while SFTP is enabled", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: true, panelBridgeSftpPollIntervalSeconds: 1 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/SFTP sync interval/);
  });

  it("accepts port 22 as a valid SFTP port when SFTP is enabled", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: true, panelBridgeSftpPort: 22 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("GitHub #118: SFTP disabled with the default port 22 does not block saving an unrelated setting", async () => {
    const res = await putAppSettings({
      panelBridgeSftpEnabled: false,
      panelBridgeSftpPort: "22",
      panelBridgeAutoUpdate: false,
    });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("still validates the SFTP port when this save is what turns SFTP on, even though it was off in storage", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: true, panelBridgeSftpPort: 0 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/SFTP port must be a whole number/);
  });

  it("skips SFTP port validation when this save is what turns SFTP off, even with an out-of-range port present", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: false, panelBridgeSftpPort: 0 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});
