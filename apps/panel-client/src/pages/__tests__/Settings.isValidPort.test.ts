import { describe, it, expect } from 'vitest'
import { isValidPort } from '../Settings'

// regression lens 4, confirmed instance: the General tab's Panel Port
// field, and the HTTPS tab's HTTPS Port field right next to it, both accept
// any numeric string with no range check -- updateSetting() only rejects
// non-numeric input, never an out-of-range one, and handleSave() submits
// whatever is typed without checking it first.
//
// The two fields are NOT equally safe once that gap reaches the server:
//   - httpsPort: apps/panel-server/routes/config.js validates it (1-65535) and rejects
//     out of range with a clear 400 -- an avoidable round trip, but the user
//     sees a real error.
//   - panelPort: apps/panel-server/routes/config.js has NO check for this key at all
//     (unlike its httpsPort sibling two cases below it in the same
//     validation loop). An out-of-range panelPort is accepted and saved
//     silently. apps/panel-server/index.js only catches it later, on the NEXT panel
//     restart, by silently falling back to port 3001 -- while Settings.tsx's
//     "Restart Panel" button redirects the browser to the port the user
//     actually typed (e.g. :99999), which nothing is listening on. The user
//     is left looking at a dead URL with no error anywhere explaining that
//     the real panel came back up somewhere else.
// This is the exact "one sibling has the guard, the other doesn't" shape --
// closing it client-side (before either field's value is ever submitted)
// fixes both, without touching server code.
describe('Settings -- isValidPort', () => {
  it('rejects ports outside 1-65535', () => {
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(-1)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(99999)).toBe(false)
    expect(isValidPort(NaN)).toBe(false)
  })

  it('accepts ports within 1-65535', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(3001)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
  })
})
