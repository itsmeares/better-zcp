import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

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

    expect(raw).toContain("line one\\r\\nline two acting as a second command");

    const parsed = JSON.parse(raw);
    expect(parsed.args.message).toBe(maliciousMessage);

    const messageValueMatch = raw.match(/"message":\s*"((?:[^"\\]|\\.)*)"/);
    expect(messageValueMatch).toBeTruthy();
    expect(messageValueMatch[1]).not.toMatch(/[\r\n]/);
  });

  it("BREAK-VERIFY CONTROL: a hand-rolled, non-escaping serializer DOES leak a raw newline into the file -- proves the assertions above are real checks, not vacuous", () => {
    const maliciousMessage = "line one\r\nline two acting as a second command";
    const brokenSerialization = `{\n  "action": "sendToServerChat",\n  "args": { "message": "${maliciousMessage}" }\n}`;

    const messageValueMatch = brokenSerialization.match(/"message":\s*"([^"]*)"/s);
    expect(messageValueMatch).toBeTruthy();
    expect(messageValueMatch[1]).toMatch(/[\r\n]/);
    expect(() => JSON.parse(brokenSerialization)).toThrow();
  });
});
