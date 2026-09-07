import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import https from "node:https";
import tls from "node:tls";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const isWindows = process.platform === "win32";
let opensslAvailable = false;
if (!isWindows) {
  try {
    execSync("openssl version", { stdio: "ignore" });
    opensslAvailable = true;
  } catch {
    opensslAvailable = false;
  }
}

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getServers: async () => [],
  getSetting: async () => null,
  setSetting: async () => {},
}));

describe.skipIf(isWindows || !opensslAvailable)(
  "DiscordBot against a real gateway/REST mock -- rate limits, reconnection, and operator-visible signal",
  () => {
    let httpsServer;
    let wss;
    let httpsPort;
    let wsPort;
    let key;
    let cert;
    let certDir;
    let originalDispatcher;

    let mock;

    function resetMock() {
      mock = {
        sendBehavior: "ok", // 'ok' | '429-then-ok'
        sendAttempts: 0,
        send429Count: 0,
        retryAfterSeconds: 1,
        heartbeatBlackhole: false,
        resumeReceivedAt: null,
        heartbeatAcksSentAfterResume: 0,
        lastReceivedMessageBody: null,
      };
    }

    beforeAll(async () => {
      certDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discord-mock-cert-"));
      const keyPath = path.join(certDir, "key.pem");
      const certPath = path.join(certDir, "cert.pem");
      execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=discord.com"`,
        { stdio: "ignore" },
      );
      key = fs.readFileSync(keyPath);
      cert = fs.readFileSync(certPath);

      resetMock();

      httpsServer = https.createServer({ key, cert }, async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const bodyText = Buffer.concat(chunks).toString("utf8") || "{}";
        const url = req.url;
        const json = (status, obj, extraHeaders = {}) => {
          res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
          res.end(JSON.stringify(obj));
        };

        if (url === "/api/v10/gateway/bot" && req.method === "GET") {
          return json(200, {
            url: `ws://127.0.0.1:${wsPort}`,
            shards: 1,
            session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
          });
        }
        if (url === "/api/v10/users/@me" && req.method === "GET") {
          return json(200, { id: "999999999999999999", username: "mock-bot" });
        }
        if (/^\/api\/v10\/applications\/.+\/commands$/.test(url)) return json(200, []);
        if (/^\/api\/v10\/applications\/.+\/guilds\/.+\/commands$/.test(url)) return json(200, []);
        if (/^\/api\/v10\/channels\/[^/]+$/.test(url) && req.method === "GET") {
          return json(200, { id: "1111", type: 0, name: "mock-channel", guild_id: "2222" });
        }
        if (/^\/api\/v10\/channels\/.+\/messages$/.test(url) && req.method === "POST") {
          mock.sendAttempts++;
          mock.lastReceivedMessageBody = bodyText;
          if (mock.sendBehavior === "ok") {
            return json(200, { id: String(Date.now()), content: JSON.parse(bodyText).content || "" });
          }
          if (mock.sendBehavior === "429-then-ok") {
            if (mock.send429Count > 0) {
              mock.send429Count--;
              return json(
                429,
                { message: "You are being rate limited.", retry_after: mock.retryAfterSeconds, global: false },
                { "retry-after": String(mock.retryAfterSeconds), "x-ratelimit-scope": "shared" },
              );
            }
            return json(200, { id: String(Date.now()) });
          }
        }
        return json(404, { message: "mock: unhandled route " + req.method + " " + url });
      });
      await new Promise((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
      httpsPort = httpsServer.address().port;

      wss = new WebSocketServer({ port: 0 });
      wsPort = wss.address().port;
      wss.on("connection", (ws) => {
        let seq = 0;
        const send = (op, d, t = null) => {
          const payload = { op, d };
          if (op === 0) {
            payload.s = ++seq;
            payload.t = t;
          }
          ws.send(JSON.stringify(payload));
        };
        send(10, { heartbeat_interval: 1000 });
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.op === 2) {
            send(
              0,
              {
                v: 10,
                user: { id: "999999999999999999", username: "mock-bot", bot: true, discriminator: "0" },
                session_id: "mock-session",
                resume_gateway_url: `ws://127.0.0.1:${wsPort}`,
                guilds: [],
                application: { id: "999999999999999999", flags: 0 },
              },
              "READY",
            );
            setImmediate(() => {
              send(
                0,
                {
                  id: "2222",
                  name: "mock-guild",
                  owner_id: "1",
                  roles: [
                    { id: "2222", name: "@everyone", permissions: "0", position: 0, color: 0, hoist: false, managed: false, mentionable: false },
                  ],
                  members: [],
                  channels: [
                    { id: "1111", type: 0, name: "mock-channel", guild_id: "2222", position: 0, permission_overwrites: [], parent_id: null, nsfw: false },
                  ],
                  emojis: [],
                  stickers: [],
                  voice_states: [],
                  presences: [],
                  member_count: 1,
                  unavailable: false,
                },
                "GUILD_CREATE",
              );
            });
          } else if (msg.op === 1) {
            if (!mock.heartbeatBlackhole) {
              send(11, null);
              if (mock.resumeReceivedAt) mock.heartbeatAcksSentAfterResume++;
            }
          } else if (msg.op === 6) {
            mock.resumeReceivedAt = Date.now();
            send(0, {}, "RESUMED");
          }
        });
      });

      originalDispatcher = getGlobalDispatcher();
      setGlobalDispatcher(
        new Agent({
          connect: (opts, cb) => {
            const socket = tls.connect(
              { host: "127.0.0.1", port: httpsPort, servername: opts.servername, rejectUnauthorized: false },
              () => cb(null, socket),
            );
            socket.on("error", (err) => cb(err, null));
          },
        }),
      );
    }, 30000);

    afterAll(async () => {
      setGlobalDispatcher(originalDispatcher);
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpsServer.close(resolve));
      fs.rmSync(certDir, { recursive: true, force: true });
    });

    let bots = [];
    afterEach(async () => {
      for (const bot of bots) {
        try {
          await bot.stop();
        } catch {
          /* best-effort teardown */
        }
      }
      bots = [];
      resetMock();
    });

    async function startBot() {
      const { DiscordBot } = await import("../services/discordBot.ts");
      const { writeUiSecretFile } = await import("../utils/uiSecretFile.ts");
      writeUiSecretFile("discordBotToken", "mock.token.value-not-real");
      const bot = new DiscordBot(
        { connected: false },
        { getServerProcessDetails: async () => ({ running: false }) },
        { performRestart: async () => ({ success: true }) },
      );
      const ok = await bot.start();
      expect(ok).toBe(true);
      bots.push(bot);
      return bot;
    }

    it(
      "suspect 2 -- a transient rate limit is genuinely WAITED OUT (Retry-After honoured), not hammered",
      async () => {
        const bot = await startBot();
        mock.sendBehavior = "429-then-ok";
        mock.send429Count = 2;
        mock.retryAfterSeconds = 1;

        const { RESTEvents } = await import("discord.js");
        const rateLimitWaitsMs = [];
        const onDebug = (message) => {
          const match = /Encountered unexpected 429 rate limit[\s\S]*?Retry After\s*:\s*(\d+)ms/.exec(message);
          if (match) rateLimitWaitsMs.push(Number(match[1]));
        };
        bot.client.rest.on(RESTEvents.Debug, onDebug);

        const t0 = Date.now();
        const result = await bot._sendToChannel("1111", "should survive 2 rate limits");
        const elapsedMs = Date.now() - t0;
        bot.client.rest.off(RESTEvents.Debug, onDebug);

        expect(result).toBe(true);
        expect(mock.sendAttempts).toBe(3);
        expect(rateLimitWaitsMs).toHaveLength(2);
        for (const waitedMs of rateLimitWaitsMs) {
          expect(waitedMs).toBeGreaterThanOrEqual(1000);
        }
        expect(elapsedMs).toBeLessThan(10000);
        expect(bot._breakerFor("1111").failures).toBe(0);
      },
      20000,
    );

    it(
      "suspect 4 + suspect 6 -- a dead-overnight gateway connection self-heals via RESUME, and getStatus() now sees it without false-alarming on the recovery itself",
      async () => {
        const bot = await startBot();

        const before = bot.getStatus();
        expect(before.running).toBe(true);
        expect(before.gatewayIssue).toBe(false);
        expect(before.gatewayDegradedSince).toBeNull();

        let sinceAtReconnecting = "not-yet-fired";
        let sinceAtResume = "not-yet-fired";
        bot.client.once("shardReconnecting", () => {
          sinceAtReconnecting = bot._gatewayDegradedSince;
        });
        bot.client.once("shardResume", () => {
          sinceAtResume = bot._gatewayDegradedSince;
        });

        mock.heartbeatBlackhole = true;
        const outageStart = Date.now();

        const deadline = outageStart + 15000;
        while (!mock.resumeReceivedAt && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(mock.resumeReceivedAt).not.toBeNull();
        expect(sinceAtReconnecting).not.toBeNull();
        expect(sinceAtReconnecting).not.toBe("not-yet-fired");

        mock.heartbeatBlackhole = false;
        const resumedAckDeadline = Date.now() + 5000;
        while (mock.heartbeatAcksSentAfterResume < 1 && Date.now() < resumedAckDeadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(mock.heartbeatAcksSentAfterResume).toBeGreaterThan(0);
        expect(sinceAtResume).toBeNull();

        expect(bot._gatewayDegradedSince).toBeNull();

        const after = bot.getStatus();
        expect(after.running).toBe(true);
        expect(after.lastStartError).toBeNull();
        expect(after.gatewayIssue).toBe(false);
        expect(after.gatewayDegradedSince).toBeNull();
      },
      25000,
    );

    it(
      "a genuinely unrecoverable gateway close (e.g. the token was revoked mid-session) sets the raw degraded signal too, via shardDisconnect not shardReconnecting",
      async () => {
        const bot = await startBot();
        expect(bot._gatewayDegradedSince).toBeNull();

        bot.client.emit("shardDisconnect", { code: 4004 }, 0);

        const setAt = bot._gatewayDegradedSince;
        expect(setAt).not.toBeNull();

        await new Promise((r) => setTimeout(r, 500));
        expect(bot._gatewayDegradedSince).toBe(setAt);
      },
      20000,
    );

    it(
      "follow-up 1 -- a known secret value never reaches the wire, even when it's embedded in an otherwise-ordinary message, redacted at the REAL discord.js REST boundary",
      async () => {
        const { writeUiSecretFile } = await import("../utils/uiSecretFile.ts");
        const FAKE_SFTP_SECRET = "fake-sftp-secret-hunter3-for-redaction-test";
        writeUiSecretFile("panelBridgeSftpPassword", FAKE_SFTP_SECRET);

        const bot = await startBot();
        const result = await bot._sendToChannel(
          "1111",
          `Command output included: ${FAKE_SFTP_SECRET} -- unexpected but real scenario`,
        );

        expect(result).toBe(true);
        expect(mock.lastReceivedMessageBody).not.toBeNull();
        expect(mock.lastReceivedMessageBody).not.toContain(FAKE_SFTP_SECRET);
        expect(mock.lastReceivedMessageBody).toContain("[REDACTED]");
        expect(mock.lastReceivedMessageBody).toContain("unexpected but real scenario");

        writeUiSecretFile("panelBridgeSftpPassword", "");
      },
      20000,
    );
  },
);
