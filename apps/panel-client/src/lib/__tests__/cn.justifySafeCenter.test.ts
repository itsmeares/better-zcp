import { describe, it, expect } from 'vitest'
import { cn } from '../utils'

// bughunt-2026-08-31: cn() = twMerge(clsx(inputs)) used bare twMerge, which
// has no idea the hand-written .justify-safe-center class (index.css --
// Tailwind's justifyContent corePlugin has no arbitrary-value support in
// this version, so this class exists to give TabsList's base an overflow-
// safe fallback) belongs to the same conflict group as real `justify-*`
// classes. Without registering it, cn("justify-safe-center", "...",
// "justify-start") let BOTH classes reach the element -- whichever one
// happened to sit later in the COMPILED STYLESHEET won the cascade tie,
// independent of which class appears later in the className string. On
// Debug.tsx's TabsList this meant the base class won over the explicit
// override, silently reproducing the exact unreachable-default-tab bug the
// override existed to prevent. These pin the real requirement: an explicit
// justify-* override must always survive the merge (win deterministically,
// not by source-order accident), and the base must survive when nothing
// overrides it.
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
