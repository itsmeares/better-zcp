import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// 2026-08-31 regression (PanelBridge Lua mod + bridge protocol): json.decode's
// string-escape handling recognized \n \r \t \b \f \" \\ \/ but had no case
// for \uXXXX -- the ONE JSON escape that isn't a single literal character.
// Falling into the `else result = result .. escape end` fallback appended
// the literal character "u" and left the four hex digits to be copied as
// ordinary string content on the next four loop iterations, so a decoded
// A became the 5 characters "u0041" instead of the 1 character "A".
// This is not a hypothetical: this file's OWN encoder (escape_str) emits
// \uXXXX for every string field containing a control character (0x00-0x1F)
// it can't spell with a named escape, and Node's JSON.stringify (server/
// services/panelBridge.js's command writer) does the same for command args
// -- so the bug fires on a round-trip entirely within this file, and on real
// command traffic from Node, not just a synthetic input.
//
// PanelBridgeModule.json is additive test-only exposure of the file-local `json`
// table (mirrors the existing PanelBridge.handlers exposure), added
// alongside this fix so json.encode/json.decode can be exercised directly.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',  'integrations', 'panelbridge',
  'PanelBridge',
  'media',
  'lua',
  'server',
  'PanelBridge.lua',
);

describe('PanelBridge.lua json.decode -- unicode escape handling', () => {
  it('decodes a unicode escape to the real character, not literal "uXXXX" text', () => {
    const bridge = loadPanelBridge(LUA_PATH);
    bridge.run(`
      __RESULT = PanelBridgeModule.json.decode('{"msg":"hello\\\\u0041world"}')
    `);
    const result = bridge.getGlobal('__RESULT');
    expect(result.msg).toBe('helloAworld');
  });

  it('round-trips a real command payload written the way apps/panel-server/services/panelBridge.js writes it (Node JSON.stringify escaping a control character)', () => {
    const bridge = loadPanelBridge(LUA_PATH);
    const bel = String.fromCharCode(7);
    // A raw BEL byte has no named JSON escape (backslash-b/f/n/r/t only),
    // so JSON.stringify falls back to the generic backslash-u00XX form.
    const nodeEncoded = JSON.stringify({ reason: `x${bel}y` });
    expect(nodeEncoded).toBe('{"reason":"x\\u0007y"}');

    bridge.run(`__RESULT = PanelBridgeModule.json.decode(${JSON.stringify(nodeEncoded)})`);
    const result = bridge.getGlobal('__RESULT');
    expect(result.reason).toBe(`x${bel}y`);
  });

  it('round-trips a control character through this file own encode -> decode', () => {
    const bridge = loadPanelBridge(LUA_PATH);
    bridge.run(`
      local encoded = PanelBridgeModule.json.encode({ reason = "x\\1y" })
      __RESULT = { encoded = encoded, decoded = PanelBridgeModule.json.decode(encoded) }
    `);
    const result = bridge.getGlobal('__RESULT');
    expect(result.encoded).toBe('{"reason":"x\\u0001y"}');
    expect(result.decoded.reason).toBe('x\x01y');
  });

  it('still fails safe on a malformed unicode escape (not 4 hex digits)', () => {
    const bridge = loadPanelBridge(LUA_PATH);
    bridge.run(`
      __RESULT = PanelBridgeModule.json.decode('{"msg":"a\\\\uZZZZb"}')
    `);
    const result = bridge.getGlobal('__RESULT');
    // Same fallback as every other unrecognized escape: literal "u", digits
    // copied as plain text. Must not crash or corrupt JSON structure.
    expect(result.msg).toBe('auZZZZb');
  });
});
