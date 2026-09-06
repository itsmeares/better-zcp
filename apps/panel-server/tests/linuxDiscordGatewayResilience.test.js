import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import https from "node:https";
import tls from "node:tls";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

// hunt-wave5-2026-08-29 suspects 2, 4, 6, against a REAL discord.js Client
// (imported unmodified, not mocked) talking to a real local mock Discord
// API + gateway over real TCP/TLS/WS framing. No real token, no real
// Discord server, no real network -- every outbound HTTPS request is
// physically redirected to this mock via an undici connector override
// (setGlobalDispatcher), and the mock's own /gateway/bot response points
// the WS handshake at a local plain ws:// mock too. discord.js believes
// it is talking to discord.com the whole time; only the physical
// destination is redirected. See apps/panel-server/tests/linuxDiscordSendTimeout.test.js
// for suspect 1 (the fix that shipped, 8d8fdb79) and
// apps/panel-server/tests/linuxDiscordTokenSecretLifecycle.test.js for suspect 3.
//
// Requires a real `openssl` binary to mint the mock HTTPS server's
// self-signed cert (present on every Linux dev/CI box this floor uses;
// not guaranteed on a bare Windows host) -- skipped, not failed, when
// unavailable, same posture as any other environment-gated integration
// test in this suite.
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

    // Mutable mock behavior, reset per test.
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
          // The RAW bytes this mock actually received on the wire -- the
          // whole point of the follow-up-1 redaction test is proving a
          // secret never reaches even this far, not just that some
          // in-process object looks clean.
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
      const { DiscordBot } = await import("../services/discordBot.js");
      const { writeUiSecretFile } = await import("../utils/uiSecretFile.js");
      writeUiSecretFile("discordBotToken", "mock.token.value-not-real");
      const bot = new DiscordBot(
        { connected: false },
        { getServerProcessDetails: async () => ({ running: false }) },
        { performRestart: async () => ({ success: true }) },
      );
      // loadConfig() reads guildId/channelId via getSetting(), which the
      // module mock above returns null for -- set the real values the bot
      // needs directly, same shortcut linuxDiscordSendTimeout.test.js uses.
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

        // The discriminating measurement used to be wall-clock elapsed time
        // (>= 1800ms, on the theory that hammering resolves in well under a
        // second while genuinely waiting out two 1s Retry-After windows
        // takes at least ~2s). That's exactly right in spirit but flaky in
        // practice: this floor runs many agents/workflows concurrently, and
        // under load the two real ~1050ms waits plus request/response
        // overhead can land under the threshold on a slow tick even though
        // the code waited correctly -- proven flaky (3/4 pass, 1/4 fail at
        // the same commit) rather than assumed.
        //
        // Fixed by observing the delay discord.js's REST layer actually
        // computed and scheduled a real wait against, instead of how long
        // this machine took to get through it. @discordjs/rest logs
        // "Encountered unexpected 429 rate limit ... Retry After: <n>ms"
        // via RESTEvents.Debug synchronously, immediately before it awaits
        // a real sleep() for exactly that many ms (verified against
        // node_modules/@discordjs/rest/dist/index.js -- no branch between
        // the log line and the await skips it). A hammering/bypassing bug
        // (e.g. our _safeDiscordMakeRequest wrapper swallowing the 429
        // before discord.js's own handler processes it) would mean this
        // message never appears for that request, or appears fewer times
        // than the mock's real 429 count -- so this keeps the same
        // discrimination the wall-clock version was reaching for, just
        // pinned to what the code decided rather than to the clock.
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
        expect(mock.sendAttempts).toBe(3); // 2 rate-limited + 1 success
        expect(rateLimitWaitsMs).toHaveLength(2); // one real, logged wait per 429 -- not zero, not fewer than the mock sent
        for (const waitedMs of rateLimitWaitsMs) {
          // retryAfterSeconds (1) * 1000 -- discord.js's own default 50ms
          // safety offset on top only ever adds to this, never subtracts,
          // so >= 1000 alone already rules out "computed ~0 / ignored it".
          expect(waitedMs).toBeGreaterThanOrEqual(1000);
        }
        // Still checks it doesn't hang: unlike the lower bound above, an
        // upper ceiling on real elapsed time is not the flaky direction --
        // load only pushes elapsed time up, never down, so this can't
        // false-fail the way the removed lower bound did. Eventually
        // resolves well inside our own 30s send ceiling (the suspect-1
        // fix) -- this is the "well-behaved 429" counterpart to that fix's
        // "pathological 429" case.
        expect(elapsedMs).toBeLessThan(10000);
        expect(bot._breakerFor("1111").failures).toBe(0); // absorbed by discord.js's own retry, breaker never saw it
      },
      20000,
    );

    it(
      "suspect 4 + suspect 6 -- a dead-overnight gateway connection self-heals via RESUME, and getStatus() now sees it without false-alarming on the recovery itself",
      async () => {
        const bot = await startBot();

        // Confirm getStatus() looks healthy before the outage, as a baseline.
        const before = bot.getStatus();
        expect(before.running).toBe(true);
        expect(before.gatewayIssue).toBe(false);
        expect(before.gatewayDegradedSince).toBeNull();

        // Wiring proof, and it must actually discriminate discordBot.js's
        // OWN handler running -- not just "discord.js emits this event",
        // which was never in question. EventEmitter invokes listeners in
        // REGISTRATION ORDER; discordBot.js's own shardReconnecting/
        // shardResume listeners are attached inside start() (already called
        // by startBot() above), strictly before the listeners this test
        // attaches next -- so by the time THESE callbacks run,
        // bot._gatewayDegradedSince already reflects whatever discordBot.js's
        // own handler did, synchronously, no race. (Polling the field
        // AFTER the fact was tried first and is genuinely racy against a
        // local loopback mock: RESUME->RESUMED can round-trip inside a
        // single 200ms poll tick, so a set-then-clear can happen entirely
        // between two checks -- caught this via break-verify below, not
        // assumed.)
        let sinceAtReconnecting = "not-yet-fired";
        let sinceAtResume = "not-yet-fired";
        bot.client.once("shardReconnecting", () => {
          sinceAtReconnecting = bot._gatewayDegradedSince;
        });
        bot.client.once("shardResume", () => {
          sinceAtResume = bot._gatewayDegradedSince;
        });

        mock.heartbeatBlackhole = true; // no HEARTBEAT_ACK, no close frame -- a genuine zombie connection
        const outageStart = Date.now();

        // Poll for @discordjs/ws to notice the missed ack and RESUME on its
        // own -- this is real library behavior, not simulated.
        const deadline = outageStart + 15000;
        while (!mock.resumeReceivedAt && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(mock.resumeReceivedAt).not.toBeNull(); // it DID notice and DID try to recover, unprompted
        // discordBot.js's shardReconnecting handler had already set the raw
        // field by the time our own listener ran, in the same tick.
        expect(sinceAtReconnecting).not.toBeNull();
        expect(sinceAtReconnecting).not.toBe("not-yet-fired");

        // Confirm it's not just noticing -- the resumed session actually
        // carries live heartbeats again once we stop blackholing.
        mock.heartbeatBlackhole = false;
        const resumedAckDeadline = Date.now() + 5000;
        while (mock.heartbeatAcksSentAfterResume < 1 && Date.now() < resumedAckDeadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(mock.heartbeatAcksSentAfterResume).toBeGreaterThan(0); // genuinely recovered, not just resumed-then-stuck
        // discordBot.js's shardResume handler had already cleared the raw
        // field back to null by the time our own listener ran.
        expect(sinceAtResume).toBeNull();

        expect(bot._gatewayDegradedSince).toBeNull();

        // The whole round trip (outage -> RESUME -> live heartbeats again)
        // measured a few seconds above, comfortably under the 30s threshold
        // -- so the PUBLIC, debounced signal must never have flipped, exactly
        // the "don't fire on every routine blip" property follow-up 2 asked
        // for. This is the fixed counterpart to the ORIGINAL suspect 6
        // finding (getStatus() used to have no field for this at ALL, so
        // `running` stayed true throughout with no way to tell a healthy
        // connection from one that had just silently survived an outage).
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

        // 4004 = Authentication failed, one of @discordjs/ws's own
        // UNRECOVERABLE_CLOSE_CODES -- the shard gives up instead of
        // retrying, so this must reach shardDisconnect, not shardReconnecting.
        // discord.js's own WebSocketManager emits this ON THE CLIENT itself
        // (this.client.emit(Events.ShardDisconnect, event, shardId)), not on
        // an intermediate .ws object -- matching that exactly here so this
        // test exercises the real event name/shape our listener is wired to.
        bot.client.emit("shardDisconnect", { code: 4004 }, 0);

        const setAt = bot._gatewayDegradedSince;
        expect(setAt).not.toBeNull();

        // Nothing clears an unrecoverable disconnect on its own -- unlike
        // the self-healing case above (shardResume/shardReady), there is no
        // library event coming that would reset this, so it's meant to stay
        // flagged until an operator (or a fresh start()) intervenes.
        await new Promise((r) => setTimeout(r, 500));
        expect(bot._gatewayDegradedSince).toBe(setAt);
      },
      20000,
    );

    it(
      "follow-up 1 -- a known secret value never reaches the wire, even when it's embedded in an otherwise-ordinary message, redacted at the REAL discord.js REST boundary",
      async () => {
        const { writeUiSecretFile } = await import("../utils/uiSecretFile.js");
        const FAKE_SFTP_SECRET = "fake-sftp-secret-hunter3-for-redaction-test";
        writeUiSecretFile("panelBridgeSftpPassword", FAKE_SFTP_SECRET);

        const bot = await startBot();
        const result = await bot._sendToChannel(
          "1111",
          `Command output included: ${FAKE_SFTP_SECRET} -- unexpected but real scenario`,
        );

        expect(result).toBe(true);
        // The assertion that actually matters: what the MOCK SERVER received
        // on the wire, not any in-process string -- proves the redaction ran
        // at the real _safeDiscordMakeRequest boundary discord.js's REST
        // manager actually calls, not merely that some helper function
        // returns the right thing in isolation.
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
