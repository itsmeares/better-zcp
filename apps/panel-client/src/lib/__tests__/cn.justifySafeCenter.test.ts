import { describe, it, expect } from 'vitest'
import { cn } from '../utils'

describe('cn() -- justify-safe-center must merge like a real justify-content utility', () => {
  it('drops justify-safe-center when an explicit justify-* override is present', () => {
    const result = cn('justify-safe-center', 'flex overflow-x-auto', 'justify-start')
    expect(result).not.toContain('justify-safe-center')
    expect(result).toContain('justify-start')
  })

  it('keeps justify-safe-center when no override is present', () => {
    const result = cn('justify-safe-center', 'flex overflow-x-auto')
    expect(result).toContain('justify-safe-center')
  })

  it('still resolves conflicts between two real justify-content classes (regression check: extending the group must not break the built-in behavior)', () => {
    const result = cn('justify-center', 'justify-end')
    expect(result).not.toContain('justify-center')
    expect(result).toContain('justify-end')
  })
})
