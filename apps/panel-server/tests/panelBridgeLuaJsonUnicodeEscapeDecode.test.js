import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';


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

  it('round-trips a real command payload written the way apps/panel-server/services/panelBridge.ts writes it (Node JSON.stringify escaping a control character)', () => {
    const bridge = loadPanelBridge(LUA_PATH);
    const bel = String.fromCharCode(7);
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
    expect(result.msg).toBe('auZZZZb');
  });
});
