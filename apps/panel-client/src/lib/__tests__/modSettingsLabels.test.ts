import { describe, expect, it } from 'vitest'
import { formatModSettingDescription, formatModSettingLabel } from '../modSettingsLabels'

describe('formatModSettingLabel', () => {
  it('removes the Sandbox prefix and separates camel-case words', () => {
    expect(formatModSettingLabel('Sandbox_ConsiderOccupations')).toBe('Consider Occupations')
    expect(formatModSettingLabel('Sandbox_MaximumZombieKills')).toBe('Maximum Zombie Kills')
  })

  it('removes the group prefix that is already displayed in the group header', () => {
    expect(formatModSettingLabel('Sandbox_BetterContainers_AllowToggleAutoLock', 'BetterContainers'))
      .toBe('Allow Toggle Auto Lock')
  })

  it('formats groups that do not have a translation', () => {
    expect(formatModSettingLabel('BetterContainers')).toBe('Better Containers')
  })

  it('keeps an actual translated label intact', () => {
    expect(formatModSettingLabel('Allow switching modes')).toBe('Allow switching modes')
  })
})

describe('formatModSettingDescription', () => {
  it('hides raw translation keys', () => {
    expect(formatModSettingDescription('BecomeDesensitized.ConsiderOccupations')).toBe('')
  })

  it('keeps player-facing help text', () => {
    expect(formatModSettingDescription('Allow players to switch modes.')).toBe('Allow players to switch modes.')
  })
})
