import { describe, expect, it } from 'vitest'
import { buildTemplateCapture, TEMPLATE_INI_EXCLUSIONS } from '../templateBuilder'

const emptySandbox = {
  settings: {},
  ZombieLore: {},
  ZombieConfig: {},
  MultiplierConfig: {},
  Map: {},
  Basement: {},
}

describe('buildTemplateCapture', () => {
  it('strips excluded identity/secret ini keys', () => {
    const { serverIni } = buildTemplateCapture(
      { PauseEmpty: 'true', RCONPassword: 'secret', ServerName: 'MyServer' },
      emptySandbox,
    )
    expect(serverIni).toEqual({ PauseEmpty: 'true' })
    for (const key of TEMPLATE_INI_EXCLUSIONS) {
      expect(serverIni).not.toHaveProperty(key)
    }
  })

  it('shapes sandboxVars into the six known sections', () => {
    const { sandboxVars } = buildTemplateCapture({}, {
      ...emptySandbox,
      settings: { Zombies: 5 },
      ZombieLore: { Speed: 2 },
    })
    expect(sandboxVars).toEqual({
      settings: { Zombies: 5 },
      ZombieLore: { Speed: 2 },
      ZombieConfig: {},
      MultiplierConfig: {},
      Map: {},
      Basement: {},
    })
  })

  it('counts ini and sandbox keys', () => {
    const capture = buildTemplateCapture(
      { PauseEmpty: 'true', PVP: 'false' },
      { ...emptySandbox, settings: { Zombies: 5 }, Map: { Foo: 1, Bar: 2 } },
    )
    expect(capture.iniKeyCount).toBe(2)
    expect(capture.sandboxKeyCount).toBe(3)
  })
})
