import { describe, it, expect } from 'vitest'
import enServerConfig from '../../locales/en/serverconfig.json'

// conv-hunt-pages-2 lens 3: this banner shows above the Server Settings tabs
// whenever the server is running, for all four of ini/sandbox/spawnpoints/
// spawnregions, with one fixed claim: "They won't reach the running game
// until the server restarts."
//
// That's only true for one of the four tabs. Reading the save handlers
// themselves (ServerConfig.tsx):
//   - sandbox: PZ's own reloadoptions command never re-reads SandboxVars.lua
//     (documented in the file's own comment) -- always needs a restart, the
//     banner is accurate here.
//   - ini: handleSaveIni calls serverFilesApi.saveAndReload(), which issues
//     a live RCON reload -- on success the toast literally says "Saved &
//     Reloaded", directly contradicting the banner the operator just read.
//   - spawnpoints / spawnregions: the save response carries its own
//     restartRequired flag and the toast switches on it -- sometimes it
//     genuinely doesn't need a restart.
// The banner's own claim needs to stop asserting something the app's own
// save flow already knows is sometimes false, rather than asserting a
// specific alternative (which tab needs what varies and isn't this test's
// concern) -- it just needs to stop being a claim the app itself contradicts.
describe('ServerConfig -- "server is running" banner copy', () => {
  it('does not unconditionally claim changes never reach the running server without a restart', () => {
    expect(enServerConfig.stopServerAlert.description).not.toMatch(
      /won.t reach the running game until the server restarts/i,
    )
  })

  // bug-hunt-2026-08-26: the banner now also shows when the provider-aware
  // lookup can't determine state (fail-closed -- see
  // apps/panel-client/src/lib/serverStatus.ts's resolveServerRunning). It must not
  // reuse the confirmed-running copy for that case, which flatly asserts
  // "The server is running" when the truth is "we don't know."
  it('has a distinct, honestly-hedged copy for the unknown-state case, not a reused confident claim', () => {
    expect(enServerConfig.stopServerAlert.unknownTitle).toBeTruthy()
    expect(enServerConfig.stopServerAlert.unknownDescription).toBeTruthy()
    expect(enServerConfig.stopServerAlert.unknownTitle).not.toBe(enServerConfig.stopServerAlert.title)
    expect(enServerConfig.stopServerAlert.unknownTitle.toLowerCase()).not.toMatch(/^the server is running/)
  })
})
