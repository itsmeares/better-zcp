import { describe, it, expect } from 'vitest'
import { getBridgeOperationTemplates, getBridgeOperationForms, getBridgeOperationGroups } from '../Events'

// conv-hunt-pages-2 lens 3/4, confirmed instance: Angela scanned all 23,740
// class files in the real B42 jar and confirmed Faction.createFaction and
// faction:removeFaction do not exist anywhere -- not under another receiver,
// not via a different signature. PanelBridge.lua's own handlers already fail
// these calls honestly (pcall catches the missing method, returns ok=false
// with a real error) rather than lying about success -- that part was
// already correct and isn't touched here.
//
// The bug was entirely client-side: Events.tsx offered "Create Faction" and
// "Remove Faction" as normal, enabled quick-pick buttons with real labels, a
// real description, and a filled-in args template, identical in every way
// to the operations that actually work. An operator had no way to tell,
// before submitting, that these two specifically could never succeed --
// copy promising a capability that doesn't exist (lens 3), on a control
// indistinguishable from a working one (lens 4).
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
