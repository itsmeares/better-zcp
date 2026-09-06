import { describe, it, expect } from 'vitest'
import { isValidGamePort, isValidPort } from '../Servers'

// regression lens 4, confirmed instance: the "Add Server" dialog's
// RCON port and game port fields, and the "Edit Server" dialog's game port
// field, had no client-side range check at all -- neither an onChange clamp
// nor a submit-time guard -- even though the server (apps/panel-server/routes/servers.js
// POST / , line ~662 and ~694) rejects both fields outside 1-65535 with a
// generic 400 "Invalid RCON port" / "Invalid server port". The Edit dialog's
// RCON port field alone had both a clamp and a submit guard (handleSaveEdit),
// which is why this gap looked deliberate rather than missing: three of the
// four (add-rcon, add-game, edit-game) port fields could carry a
// server-rejectable value all the way to a submit click with the button
// still enabled and no inline warning -- the user only found out from a
// generic toast after the round trip.
describe('Servers -- isValidPort', () => {
  it('rejects ports outside 1-65535, matching the server-side range check', () => {
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(-1)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(99999)).toBe(false)
    expect(isValidPort(NaN)).toBe(false)
  })

  it('accepts ports within 1-65535', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(27015)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
    expect(isValidPort(1.5)).toBe(false)
  })
})

describe('Servers -- isValidGamePort', () => {
  it('rejects 65535 because the derived UDP port would be invalid', () => {
    expect(isValidGamePort(65535)).toBe(false)
    expect(isValidGamePort(65534)).toBe(true)
  })
})
