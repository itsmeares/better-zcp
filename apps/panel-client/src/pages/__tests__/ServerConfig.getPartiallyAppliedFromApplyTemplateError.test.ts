import { describe, it, expect } from 'vitest'
import { ApiError } from '@/lib/api'
import { getPartiallyAppliedFromApplyTemplateError } from '../ServerConfig'

describe('ServerConfig -- getPartiallyAppliedFromApplyTemplateError', () => {
  it('returns the array when the server reports a partial apply', () => {
    const error = new ApiError('Failed to write Sandbox file', {
      status: 500,
      data: { error: 'Failed to write Sandbox file', success: false, partiallyApplied: ['INI'] },
    })
    expect(getPartiallyAppliedFromApplyTemplateError(error)).toEqual(['INI'])
  })

  it('returns null for a plain ApiError with no partiallyApplied field (nothing landed)', () => {
    const error = new ApiError('No settings to apply from this template', {
      status: 400,
      data: { error: 'No settings to apply from this template', code: 'TEMPLATE_APPLY_NOTHING_TO_APPLY' },
    })
    expect(getPartiallyAppliedFromApplyTemplateError(error)).toBeNull()
  })

  it('returns null when partiallyApplied is present but empty', () => {
    const error = new ApiError('boom', { status: 500, data: { partiallyApplied: [] } })
    expect(getPartiallyAppliedFromApplyTemplateError(error)).toBeNull()
  })

  it('returns null for a non-ApiError (network failure, plain Error, etc.)', () => {
    expect(getPartiallyAppliedFromApplyTemplateError(new Error('fetch failed'))).toBeNull()
    expect(getPartiallyAppliedFromApplyTemplateError('not even an Error')).toBeNull()
    expect(getPartiallyAppliedFromApplyTemplateError(undefined)).toBeNull()
  })

  it('returns null when ApiError.data has no partiallyApplied key at all', () => {
    const error = new ApiError('Template not found', { status: 404, data: { error: 'Template not found' } })
    expect(getPartiallyAppliedFromApplyTemplateError(error)).toBeNull()
  })
})
