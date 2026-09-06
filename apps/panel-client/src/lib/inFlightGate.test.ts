import { describe, expect, it } from 'vitest'
import { createInFlightGate } from './inFlightGate'

describe('createInFlightGate', () => {
  it('rejects overlapping work and reopens after completion', () => {
    const gate = createInFlightGate()

    expect(gate.enter()).toBe(true)
    expect(gate.enter()).toBe(false)

    gate.leave()

    expect(gate.enter()).toBe(true)
  })
})
