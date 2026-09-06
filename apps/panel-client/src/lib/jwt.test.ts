import { describe, expect, it } from 'vitest'
import { isTokenExpiredOrNearExpiry } from './jwt'

function makeToken(payload: Record<string, unknown>): string {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.signature-not-checked`
}

describe('isTokenExpiredOrNearExpiry', () => {
  it('is false for a token comfortably within its lifetime', () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) + 15 * 60 })
    expect(isTokenExpiredOrNearExpiry(token)).toBe(false)
  })

  it('is true for a token that has already expired', () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) - 60 })
    expect(isTokenExpiredOrNearExpiry(token)).toBe(true)
  })

  it('is true within the buffer window even though exp is technically still in the future', () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) + 30 })
    expect(isTokenExpiredOrNearExpiry(token, 60_000)).toBe(true)
  })

  it('is false just outside the buffer window', () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) + 90 })
    expect(isTokenExpiredOrNearExpiry(token, 60_000)).toBe(false)
  })

  it('treats a malformed token as needing a refresh rather than throwing', () => {
    expect(isTokenExpiredOrNearExpiry('not-a-real-jwt')).toBe(true)
    expect(isTokenExpiredOrNearExpiry('')).toBe(true)
    expect(isTokenExpiredOrNearExpiry('a.b')).toBe(true)
  })

  it('treats a token whose payload has no exp claim as needing a refresh', () => {
    const token = makeToken({ sub: 'user-1' })
    expect(isTokenExpiredOrNearExpiry(token)).toBe(true)
  })
})
