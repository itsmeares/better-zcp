import { describe, it, expect } from 'vitest'
import { isCustomLauncherPath } from '../Servers'

// decision 2026-08-27 (card
// custom-launcher-as-a-real-supported-mode-not-an-accident): a
// serverPath/installPath ending in .bat/.sh/.exe is CUSTOM LAUNCHER mode --
// real and supported, not an accident. This is the client-side mirror of
// apps/panel-server/services/serverManager.js's resolveLaunchMode() classifier, used
// only to decide when to show the "the panel will not manage this script"
// notice in the Add/Edit Server dialogs -- the server remains the
// authoritative check.
describe('Servers -- isCustomLauncherPath', () => {
  it('recognizes .bat/.sh/.exe paths, case-insensitively', () => {
    expect(isCustomLauncherPath('D:\\PZServer\\StartServer64.bat')).toBe(true)
    expect(isCustomLauncherPath('D:\\PZServer\\Launch.BAT')).toBe(true)
    expect(isCustomLauncherPath('/opt/pz/start-server.sh')).toBe(true)
    expect(isCustomLauncherPath('/opt/pz/Start.Sh')).toBe(true)
    expect(isCustomLauncherPath('C:\\PZ\\launcher.exe')).toBe(true)
    expect(isCustomLauncherPath('C:\\PZ\\launcher.EXE')).toBe(true)
  })

  it('treats an ordinary directory path as managed, not custom', () => {
    expect(isCustomLauncherPath('D:\\PZServer')).toBe(false)
    expect(isCustomLauncherPath('/opt/pz')).toBe(false)
  })

  it('treats a file with an unrecognized extension as managed -- not a launcher this mode covers', () => {
    expect(isCustomLauncherPath('D:\\PZServer\\readme.txt')).toBe(false)
  })

  it('handles empty/undefined/null without throwing', () => {
    expect(isCustomLauncherPath('')).toBe(false)
    expect(isCustomLauncherPath(undefined)).toBe(false)
    expect(isCustomLauncherPath(null)).toBe(false)
  })
})
