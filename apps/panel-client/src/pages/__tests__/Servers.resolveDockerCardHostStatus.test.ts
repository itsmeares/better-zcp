import { describe, it, expect } from 'vitest'
import { resolveDockerCardHostStatus } from '../Servers'

// GH#114 family, closing instance: a non-active server card's badge used to
// read serverStatuses (the local process scan) for EVERY non-remote server,
// docker-mapped or not. That scan can never see a process running in a
// DIFFERENT container, so a docker-mapped server that was not currently
// active would always read as stopped even while genuinely running. This
// covers the replacement source -- the already-fetched managed-container
// list -- in isolation from the component render.
describe('Servers -- resolveDockerCardHostStatus', () => {
  it('reports running when the managed container is found and running', () => {
    expect(resolveDockerCardHostStatus(true, { state: 'running' })).toBe('running')
  })

  it('reports stopped when the managed container is found but not running', () => {
    expect(resolveDockerCardHostStatus(true, { state: 'exited' })).toBe('stopped')
  })

  // Fail-closed, mirroring apps/panel-server/utils/serverStatusModel.js's buildHostSignal:
  // a lookup that cannot confirm the container's state must never render a
  // confident "stopped" -- that is the exact shape GH#114 was.
  it('reports unknown, not stopped, when Docker control itself is unavailable', () => {
    expect(resolveDockerCardHostStatus(false, { state: 'running' })).toBe('unknown')
  })

  it('reports unknown, not stopped, when the mapped container cannot be found in the list', () => {
    expect(resolveDockerCardHostStatus(true, undefined)).toBe('unknown')
  })
})
