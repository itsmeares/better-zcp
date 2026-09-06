import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import { getLoginErrorMessage, LOGIN_FAILED_MESSAGE } from '../AuthContext'

describe('getLoginErrorMessage', () => {
  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('maps a network TypeError to the CORS/connectivity message', () => {
    expect(getLoginErrorMessage(new TypeError('Failed to fetch'))).toContain('Connection blocked by browser origin policy')
  })

  it('maps a cors-flavored Error message to the same CORS message', () => {
    expect(getLoginErrorMessage(new Error('CORS request did not succeed'))).toContain('Connection blocked by browser origin policy')
  })

  it('keeps the exact generic auth-failed text for a 401 -- the enumeration-safe case, unchanged', () => {
    const error = new ApiError('Invalid username or password', { status: 401 })
    expect(getLoginErrorMessage(error)).toBe(LOGIN_FAILED_MESSAGE)
  })

  it('keeps the exact generic auth-failed text for a 400', () => {
    const error = new ApiError('Username and password are required', { status: 400 })
    expect(getLoginErrorMessage(error)).toBe(LOGIN_FAILED_MESSAGE)
  })

  it('does NOT collapse a genuine 500 into the generic auth-failed text -- this is the actual fix', () => {
    const error = new ApiError('Database connection failed', { status: 500 })
    const message = getLoginErrorMessage(error)
    expect(message).not.toBe(LOGIN_FAILED_MESSAGE)
    expect(message).toContain('Database connection failed')
  })

  it('translates a registered 5xx-adjacent code the same way getUserErrorMessage does everywhere else', () => {
    void i18n.changeLanguage('fr')
    const error = new ApiError('Some unexpected failure', { status: 503 })
    expect(getLoginErrorMessage(error)).toContain("n'était pas attendu")
  })

  it('falls back to the generic text for a non-ApiError, non-network error', () => {
    expect(getLoginErrorMessage(new Error('something else'))).toBe(LOGIN_FAILED_MESSAGE)
  })

  it('falls back to the generic text for a non-error value', () => {
    expect(getLoginErrorMessage('a plain string')).toBe(LOGIN_FAILED_MESSAGE)
  })
})
