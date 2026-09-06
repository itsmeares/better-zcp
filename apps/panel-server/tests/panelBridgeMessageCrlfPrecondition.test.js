import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-29 issue (testing): panelbridge-message-crlf-strip-rests-on-
// json-stringify. A PRECONDITION RECORD, not a bug: server.js's RCON
// POST /message strips CR/LF before rconService.serverMessage() because RCON
// is a line-oriented text protocol where an embedded newline could be read
// as a second command. panelBridge.js's POST /message does NOT strip -- and
// that has been safe only because the command is written to disk via
// JSON.stringify, which escapes an embedded \r or \n into the two-character
// sequence \r/\n rather than a literal control byte, so it can never look
// like a queue-file structural break. Confirmed this still holds at current
// main (apps/panel-server/routes/panelBridge.js:2266's POST /message passes `message`
// straight to bridge.sendCommand("sendToServerChat", ...) with no strip;
// panelBridge.js service's _enqueueCommand -- the PRIMARY write path
// sendCommand uses today -- writes the command via
// JSON.stringify(payload, null, 2)), and additionally verified the Lua
// mod's own hand-rolled json.decode (integrations/panelbridge/PanelBridge/media/lua/server/
// PanelBridge.lua) correctly un-escapes \n and \r back to real characters
// (lines 896-897), so this isn't just "JS escapes it" -- the read side
// actually decodes it back into a safely-contained string value rather than
// a raw file-structural newline.
//
// This test pins the PRECONDITION itself: if a future change swaps
// JSON.stringify for something that doesn't escape control characters (a
// hand-rolled template string, a different serializer), this fails loudly
// instead of the guarantee silently evaporating with nothing to notice.
const { PanelBridge } = await import("../services/panelBridge.js");

let tmpDir;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("panelBridge.js _enqueueCommand -- an embedded CR/LF in a chat message never reaches the queue file as a raw control byte", () => {
  it("escapes \\r\\n inside args.message so the file's own JSON structure can't be split by it", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-crlf-"));
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);

    const maliciousMessage = "line one\r\nline two acting as a second command";
    bridge._enqueueCommand("test-id-1", "sendToServerChat", {
      message: maliciousMessage,
      isAlert: true,
    });

    const inboxDir = path.join(tmpDir, "inbox");
    const cmdFile = fs
      .readdirSync(inboxDir)
      .find((f) => f.startsWith("cmd-"));
    expect(cmdFile).toBeTruthy();

    const raw = fs.readFileSync(path.join(inboxDir, cmdFile), "utf-8");

    // The escaped form must be present verbatim in the file text -- this is
    // what a hand-rolled/non-escaping serializer would NOT produce.
    expect(raw).toContain("line one\\r\\nline two acting as a second command");

    // And round-tripping the whole file through JSON.parse must recover the
    // exact original string, proving the escaping is correct, not merely
    // present.
    const parsed = JSON.parse(raw);
    expect(parsed.args.message).toBe(maliciousMessage);

    // The only real CR/LF bytes anywhere in the file are JSON.stringify's
    // own pretty-print formatting (outside any string value) -- none of
    // them may fall inside what should be the escaped message string.
    const messageValueMatch = raw.match(/"message":\s*"((?:[^"\\]|\\.)*)"/);
    expect(messageValueMatch).toBeTruthy();
    expect(messageValueMatch[1]).not.toMatch(/[\r\n]/);
  });

  it("BREAK-VERIFY CONTROL: a hand-rolled, non-escaping serializer DOES leak a raw newline into the file -- proves the assertions above are real checks, not vacuous", () => {
    // Simulates what would happen if a future refactor built the command
    // file with string interpolation instead of JSON.stringify.
    const maliciousMessage = "line one\r\nline two acting as a second command";
    const brokenSerialization = `{\n  "action": "sendToServerChat",\n  "args": { "message": "${maliciousMessage}" }\n}`;

    const messageValueMatch = brokenSerialization.match(/"message":\s*"([^"]*)"/s);
    expect(messageValueMatch).toBeTruthy();
    // With no escaping, the raw CR/LF survives straight into what should be
    // a single JSON string value.
    expect(messageValueMatch[1]).toMatch(/[\r\n]/);
    expect(() => JSON.parse(brokenSerialization)).toThrow();
  });
});
