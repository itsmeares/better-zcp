import { describe, it, expect } from 'vitest'
import en from '../../locales/en/chunkCleaner.json'


describe('ChunkCleaner -- the chunk-selection canvas no longer claims keyboard support it cannot deliver', () => {
  it('states plainly that selecting areas requires a mouse or touchscreen', () => {
    expect(en.canvas.ariaLabel).toMatch(/mouse or touchscreen/i)
    expect(en.canvas.ariaLabel).toMatch(/not keyboard-operable/i)
  })

  it('no longer phrases the label as an action the viewer can just perform', () => {
    expect(en.canvas.ariaLabel).not.toBe('Chunk map — select areas to clean up')
  })
})
