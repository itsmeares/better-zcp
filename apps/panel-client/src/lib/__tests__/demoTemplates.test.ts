import { describe, expect, it } from 'vitest'
import { getDemoTemplates, isDemoMode } from '../demo'

describe('demo template API contract', () => {
  it('provides a template array with fields required by the Templates page', () => {
    const response = getDemoTemplates()

    expect(Array.isArray(response.templates)).toBe(true)
    expect(response.templates.length).toBeGreaterThan(0)
    expect(response.templates[0]).toEqual(expect.objectContaining({
      schemaVersion: 1,
      isBuiltin: true,
      meta: expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        tags: expect.any(Array),
      }),
      mods: expect.any(Array),
      difficulty: expect.any(Object),
    }))
  })

  it('does not enable demo mode in the regular test environment', () => {
    expect(isDemoMode()).toBe(false)
  })

})