import { expect, it } from 'vite-plus/test'
import type { SandboxData } from '@/lib/api'
import { backupFileType, changedSandboxFields, getUnpersistedSandboxKeys, rawChangePreview } from '../config/configFiles'

it('sends only the sandbox values that changed', () => {
  const before = { VERSION: 4, settings: { DayLength: 3, Zombies: 4 }, ZombieLore: { Speed: 2 } } as unknown as SandboxData
  const after = { VERSION: 4, settings: { DayLength: 3, Zombies: 2 }, ZombieLore: { Speed: 2 } } as unknown as SandboxData
  expect(changedSandboxFields(after, before)).toEqual({ settings: { Zombies: 2 } })
})

it('hides secrets in the raw save preview', () => {
  const preview = rawChangePreview('PublicName=A\nRCONPassword=old', 'PublicName=B\nRCONPassword=new')
  expect(preview[0]).toContain('PublicName=A')
  expect(preview[1]).toBe('Line 2: (hidden) → (hidden)')
})

it('reads backup types and unsaved keys', () => {
  expect(backupFileType('Demo_ini_2026.bak')).toBe('ini')
  expect(backupFileType('Demo_SandboxVars.lua.bak')).toBe('sandbox')
  expect(backupFileType('notes.txt')).toBeNull()
  expect(getUnpersistedSandboxKeys({ unpersistedKeys: ['A'] })).toEqual(['A'])
  expect(getUnpersistedSandboxKeys({ unpersistedKeys: [] })).toBeNull()
})
