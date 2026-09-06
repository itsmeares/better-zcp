import { describe, expect, it } from 'vitest'
import de from '../de/debug.json'

describe('German system status translations', () => {
  it('uses operational wording for a healthy server state', () => {
    expect(de.healthTab.healthy).toBe('Betriebsbereit')
    expect(de.healthTab.healthy).not.toBe('Gesund')
  })
})