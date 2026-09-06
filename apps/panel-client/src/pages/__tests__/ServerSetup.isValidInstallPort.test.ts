import { describe, it, expect } from 'vitest'
import { isValidGamePort, isValidInstallPort } from '../ServerSetup'

// conv-hunt-pages-2 lens 4b, previously deferred: apps/panel-server/routes/server.js's
// /install, /quick-setup, /configure-rcon and /configure-network used to
// silently coerce an out-of-range rconPort/serverPort to a default (via the
// old validateInt()) rather than reject -- so there was no server rejection
// to route around, and this page was set aside twice for that reason.
// Kevin's 39f836f (requireIntInRange, server.js:1741/1745/2244/2248/2422/2500)
// closed that gap: those four endpoints now return a 400 naming the field and
// its range (1024-65535) instead of silently substituting a default. That
// makes the premise for deferring ServerSetup.tsx false -- the four
// install/quick-setup port fields (rconPort, serverPort) were always bare
// `parseInt(e.target.value) || default` with no clamp, same shape already
// fixed on Servers.tsx/Settings.tsx/Players.tsx.
describe('ServerSetup -- isValidInstallPort', () => {
  it('rejects ports outside 1024-65535, matching requireIntInRange on the server', () => {
    expect(isValidInstallPort(0)).toBe(false)
    expect(isValidInstallPort(1023)).toBe(false)
    expect(isValidInstallPort(80)).toBe(false)
    expect(isValidInstallPort(65536)).toBe(false)
    expect(isValidInstallPort(NaN)).toBe(false)
  })

  it('accepts ports within 1024-65535', () => {
    expect(isValidInstallPort(1024)).toBe(true)
    expect(isValidInstallPort(27015)).toBe(true)
    expect(isValidInstallPort(65535)).toBe(true)
  })
})

// FOLLOW-UP (god's review of f1ce821): the bare `parseInt(e.target.value) ||
// default` onChange this file's own header comment described was still live
// on all four of this page's port fields, plus 9 more across
// Servers.tsx/Players.tsx/Scheduler.tsx -- clearing the field snapped it
// straight back to the hardcoded default under the operator's cursor. Fixed
// by routing every one of those sites through one shared component,
// NumberInput (apps/panel-client/src/components/NumberInput.tsx, tests in
// apps/panel-client/src/components/__tests__/NumberInput.test.tsx) -- it lets the field
// go empty and reports NaN upward instead of substituting a default.
// isValidInstallPort(NaN) === false above is exactly the mechanism that
// makes that safe: an empty rconPort/serverPort field is refused at submit
// time by the SAME check that already refused an out-of-range one, with no
// second validation path invented for the empty case.
describe('isValidInstallPort composes with NumberInput leaving a cleared field as NaN', () => {
  it('a field the operator emptied is indistinguishable, to this check, from any other invalid port', () => {
    const clearedField = NaN // what NumberInput reports for an empty/unparseable field
    expect(isValidInstallPort(clearedField)).toBe(isValidInstallPort(999999)) // both false, same refusal path
  })
})

describe('ServerSetup -- isValidGamePort', () => {
  it('rejects 65535 because the derived UDP port would overflow', () => {
    expect(isValidGamePort(65535)).toBe(false)
    expect(isValidGamePort(65534)).toBe(true)
  })
})
