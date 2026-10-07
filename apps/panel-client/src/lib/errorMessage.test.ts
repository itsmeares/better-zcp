import { expect, it } from 'vite-plus/test'
import { ApiError } from './ApiError'
import { getRecoveryUrl } from './errorMessage'

it('sends connection and integration errors to Server settings, where those settings live', () => {
  expect(getRecoveryUrl(new ApiError('Bad password', { code: 'RCON_CONNECT_AUTH_FAILED' }))).toBe('/server-settings')
  expect(getRecoveryUrl(new ApiError('Host down', { code: 'RCON_CONNECT_UNREACHABLE' }))).toBeNull()
  expect(getRecoveryUrl(new Error('RCON authentication failed'))).toBe('/server-settings')
  expect(getRecoveryUrl(new Error('Game integration not running'))).toBe('/server-settings')
  expect(getRecoveryUrl(new Error('No active server'))).toBe('/servers')
  expect(getRecoveryUrl(new Error('Something else'))).toBeNull()
})
