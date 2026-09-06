import { describe, it, expect } from 'vitest'
import { getBridgeOperationTemplates } from '../Events'
import en from '../../locales/en/events.json'


const t = ((key: string) => key) as Parameters<typeof getBridgeOperationTemplates>[0]

describe('Events -- bridge operation description audit (2026-08-27)', () => {
  it('every rendered bridge operation has a non-empty description -- none can ship silently blank', () => {
    const templates = getBridgeOperationTemplates(t)
    for (const [key, meta] of Object.entries(templates)) {
      expect(meta.description, `${key} has no description`).toBeTruthy()
      expect(meta.description.trim().length, `${key}'s description is blank`).toBeGreaterThan(0)
    }
  })

  it('does not render the two orphaned faction locale entries -- confirms they stay dead, not just currently unused', () => {
    const templates = getBridgeOperationTemplates(t)
    expect(Object.keys(templates)).not.toContain('createFaction')
    expect(Object.keys(templates)).not.toContain('removeFaction')
    expect(en.operations).toHaveProperty('createFaction')
    expect(en.operations).toHaveProperty('removeFaction')
  })
})
