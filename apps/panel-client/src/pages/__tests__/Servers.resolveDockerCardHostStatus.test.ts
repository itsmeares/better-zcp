import { describe, it, expect } from 'vitest'
import { resolveDockerCardHostStatus } from '../Servers'

describe('Servers -- resolveDockerCardHostStatus', () => {
  it('reports running when the managed container is found and running', () => {
    expect(resolveDockerCardHostStatus(true, { state: 'running' })).toBe('running')
  })

  it('reports stopped when the managed container is found but not running', () => {
    expect(resolveDockerCardHostStatus(true, { state: 'exited' })).toBe('stopped')
  })

  it('reports unknown, not stopped, when Docker control itself is unavailable', () => {
    expect(resolveDockerCardHostStatus(false, { state: 'running' })).toBe('unknown')
  })

  it('reports unknown, not stopped, when the mapped container cannot be found in the list', () => {
    expect(resolveDockerCardHostStatus(true, undefined)).toBe('unknown')
  })
})
