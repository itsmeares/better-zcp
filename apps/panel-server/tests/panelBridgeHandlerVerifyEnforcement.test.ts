import { describe, expect, it } from 'vite-plus/test'
import fs from 'node:fs'
import path from 'node:path'
import { loadPanelBridge } from './helpers/panelBridgeLua.ts'

const LUA_PATH = path.resolve('integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua')
const READ_OR_INTERNAL = new Set([
  'checkAPI', 'debugItemScript', 'getAllPlayerDetails', 'getAllSandboxOptions',
  'getAvailableHandlers', 'getDebugLog', 'getInfrastructureSnapshot',
  'getItemCatalog', 'getPlayerDetails', 'getSandboxOptions', 'getServerInfo',
  'getStats', 'getUtilitiesStatus', 'getWorldStats', 'ping', 'setDebugMode',
  'clearErrors',
])
const EQUIVALENT_VERIFY = new Set([
  'healPlayer', // Missing body damage reports failure; health restoration has no cheap readback.
  'giveItem', // Reports how many AddItem calls actually succeeded.
  'killPlayer', // The returned ok value reads isDead().
  'saveWorld', // The returned ok value reflects saveGame() success.
  'moderationKickUser', // The Build 42 kick API has no delivery receipt.
  'sendToServerChat', // The chat API has no delivery receipt.
])

describe('PanelBridge mutation verification', () => {
  it('requires every retained mutating handler to verify its outcome or document its limit', () => {
    const bridge = loadPanelBridge(LUA_PATH, '')
    bridge.run(`
      __names = {}
      __lines = {}
      for name, fn in pairs(PanelBridgeModule.handlers) do
        local info = debug.getinfo(fn, "S")
        table.insert(__names, name)
        __lines[name] = { linedefined = info.linedefined, lastlinedefined = info.lastlinedefined }
      end
    `)
    const names: string[] = bridge.getGlobal('__names')
    const lines = bridge.getGlobal('__lines')
    const known = new Set(names)
    for (const name of [...READ_OR_INTERNAL, ...EQUIVALENT_VERIFY]) {
      expect(known.has(name), `${name} is no longer registered`).toBe(true)
    }
    const source = fs.readFileSync(LUA_PATH, 'utf8').split('\n')
    for (const name of names) {
      if (READ_OR_INTERNAL.has(name) || EQUIVALENT_VERIFY.has(name)) continue
      const range = lines[name]
      const body = source.slice(range.linedefined - 1, range.lastlinedefined).join('\n')
      expect(body, `${name} claims a mutation without a verification result`).toContain('verified')
    }
  })
})
