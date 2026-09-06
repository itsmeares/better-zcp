import { describe, it, expect } from 'vitest'
import { getBridgeOperationTemplates, getBridgeOperationForms, getBridgeOperationGroups } from '../Events'

const t = ((key: string) => key) as Parameters<typeof getBridgeOperationTemplates>[0]

describe('Events -- bridge faction operations catalog', () => {
  it('does not offer createFaction or removeFaction -- Faction.createFaction/removeFaction do not exist in the real B42 jar', () => {
    const templates = getBridgeOperationTemplates(t)
    const forms = getBridgeOperationForms(t)
    const groups = getBridgeOperationGroups(t)
    const territory = groups.find((g) => g.id === 'territory')

    expect(templates.createFaction).toBeUndefined()
    expect(templates.removeFaction).toBeUndefined()
    expect(forms.createFaction).toBeUndefined()
    expect(forms.removeFaction).toBeUndefined()
    expect(territory?.operations).not.toContain('createFaction')
    expect(territory?.operations).not.toContain('removeFaction')
  })

  it('still offers the faction operations that call real, working methods', () => {
    const templates = getBridgeOperationTemplates(t)
    const forms = getBridgeOperationForms(t)
    const groups = getBridgeOperationGroups(t)
    const territory = groups.find((g) => g.id === 'territory')

    for (const op of ['getFactions', 'factionAddPlayer', 'factionRemovePlayer', 'factionSetTag']) {
      expect(templates[op]).toBeDefined()
      expect(forms[op]).toBeDefined()
      expect(territory?.operations).toContain(op)
    }
  })
})
