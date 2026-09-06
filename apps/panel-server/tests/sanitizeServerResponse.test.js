import { describe, expect, it } from "vitest";
import {
  SENSITIVE_FIELD_RE,
  isMaskedSecret,
  maskSensitiveObject,
  sanitizeServerResponse,
  sanitizeServerResponseList,
} from "../utils/sanitize.js";

describe("SENSITIVE_FIELD_RE / maskSensitiveObject", () => {
  it("masks every secret-shaped field, including ones added after the fact", () => {
    const settings = {
      rconPassword: "rcon-secret-1234",
      // Finding 1: jwtSecret was missing from the old explicit key list.
      jwtSecret: "super-secret-jwt-signing-key",
      // Finding 3/4: discordBotToken was missing from the old list too.
      discordBotToken: "discord-bot-token-abcd",
      steamApiKey: "steam-key-abcd",
      steamSessionId: "session-id-abcd",
      steamLoginSecure: "login-secure-abcd",
      panelBridgeSftpPassword: "sftp-pass-abcd",
      discordWebhookUrl: "webhook-abcd",
      darkMode: true,
      serverName: "MyServer",
    };

    const masked = maskSensitiveObject(settings);

    for (const key of [
      "rconPassword",
      "jwtSecret",
      "discordBotToken",
      "steamApiKey",
      "steamSessionId",
      "steamLoginSecure",
      "panelBridgeSftpPassword",
      "discordWebhookUrl",
    ]) {
      expect(masked[key]).toMatch(/^••••••••/);
      expect(masked[key]).not.toBe(settings[key]);
    }

    // Non-secret fields pass through untouched.
    expect(masked.darkMode).toBe(true);
    expect(masked.serverName).toBe("MyServer");
  });

  it("does not mutate the original object", () => {
    const settings = { rconPassword: "secret-value" };
    const masked = maskSensitiveObject(settings);
    expect(settings.rconPassword).toBe("secret-value");
    expect(masked).not.toBe(settings);
  });

  it("leaves empty or non-string secret fields alone", () => {
    const settings = { rconPassword: "", jwtSecret: null };
    const masked = maskSensitiveObject(settings);
    expect(masked.rconPassword).toBe("");
    expect(masked.jwtSecret).toBeNull();
  });

  it("recognizes the canonical field names from the regex directly", () => {
    for (const key of ["password", "apiKey", "sessionId", "loginSecure", "webhookUrl"]) {
      expect(SENSITIVE_FIELD_RE.test(key)).toBe(true);
    }
    expect(SENSITIVE_FIELD_RE.test("serverName")).toBe(false);
  });
});

describe("isMaskedSecret", () => {
  it("detects the canonical mask sentinel", () => {
    expect(isMaskedSecret("••••••••1234")).toBe(true);
  });

  it("rejects real-looking secret values", () => {
    expect(isMaskedSecret("real-rcon-password")).toBe(false);
  });

  it("rejects empty and non-string values", () => {
    expect(isMaskedSecret("")).toBe(false);
    expect(isMaskedSecret(undefined)).toBe(false);
    expect(isMaskedSecret(null)).toBe(false);
  });
});

describe("sanitizeServerResponse", () => {
  it("strips rconPassword and adminPassword from a server record", () => {
    const server = {
      id: "server-1",
      name: "Test Server",
      rconHost: "127.0.0.1",
      rconPassword: "super-secret-rcon",
      adminPassword: "super-secret-admin",
    };

    const sanitized = sanitizeServerResponse(server);

    expect(sanitized.rconPassword).not.toBe("super-secret-rcon");
    expect(sanitized.adminPassword).not.toBe("super-secret-admin");
    expect(sanitized.rconPassword).toMatch(/^••••••••/);
    expect(sanitized.name).toBe("Test Server");
    expect(sanitized.rconHost).toBe("127.0.0.1");
  });

  it("masks every server in a list", () => {
    const servers = [
      { id: "1", rconPassword: "secret-one" },
      { id: "2", rconPassword: "secret-two" },
    ];
    const sanitized = sanitizeServerResponseList(servers);
    expect(sanitized[0].rconPassword).not.toBe("secret-one");
    expect(sanitized[1].rconPassword).not.toBe("secret-two");
  });

  it("passes through non-array input from sanitizeServerResponseList unchanged", () => {
    expect(sanitizeServerResponseList(null)).toBeNull();
  });
});
