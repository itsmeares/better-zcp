import { describe, it, expect } from 'vitest'
import { getApplyTemplateBackupWarnings } from '../ServerConfig'

describe('ServerConfig.tsx getApplyTemplateBackupWarnings: reads POST /templates/:id/apply\'s backupWarnings diagnostic', () => {
  it('returns the warnings when one or both backups failed', () => {
    expect(getApplyTemplateBackupWarnings({ backupWarnings: ['ini backup failed'] })).toEqual([
      'ini backup failed',
    ])
    expect(
      getApplyTemplateBackupWarnings({
        backupWarnings: ['ini backup failed', 'sandbox backup failed'],
      }),
    ).toEqual(['ini backup failed', 'sandbox backup failed'])
  })

  it('returns null when backupWarnings is an empty array (both backups succeeded)', () => {
    expect(getApplyTemplateBackupWarnings({ backupWarnings: [] })).toBeNull()
  })

  it('returns null when backupWarnings is absent (normal successful apply)', () => {
    expect(getApplyTemplateBackupWarnings({})).toBeNull()
    expect(getApplyTemplateBackupWarnings(undefined)).toBeNull()
    expect(getApplyTemplateBackupWarnings(null)).toBeNull()
  })
})
