import { describe, expect, it, vi } from 'vitest'
import { deriveDashboardStatus, resolveClientProvider, resolveServerCardRunning, resolveServerRunning, toClientRunState, waitForServerState } from '../serverStatus'

describe('toClientRunState', () => {
  it('keeps a server that is running but not ready out of the ready state', () => {
    expect(toClientRunState('ready')).toBe('running')
    expect(toClientRunState('running-not-ready')).toBe('transitioning')
    expect(toClientRunState('starting')).toBe('transitioning')
    expect(toClientRunState('stopped')).toBe('stopped')
    expect(toClientRunState('unknown')).toBe('unknown')
  })
})

describe('resolveClientProvider', () => {
  it('returns null for no server', () => {
    expect(resolveClientProvider(null)).toBeNull()
    expect(resolveClientProvider(undefined)).toBeNull()
  })

  it('maps isRemote to remote-sftp regardless of any docker fields', () => {
    expect(resolveClientProvider({ isRemote: true })).toBe('remote-sftp')
    expect(resolveClientProvider({ isRemote: true, dockerContainerName: 'pz' })).toBe('remote-sftp')
  })

  it('maps a dockerContainerName mapping to docker-local, not native', () => {
    expect(resolveClientProvider({ isRemote: false, dockerContainerName: 'pz-server' })).toBe(
      'docker-local',
    )
  })

  it('maps a dockerContainerId mapping to docker-local, not native', () => {
    expect(resolveClientProvider({ isRemote: false, dockerContainerId: 'container-id' })).toBe(
      'docker-local',
    )
  })

  it('defaults to native only when neither isRemote nor dockerContainerName is set', () => {
    expect(resolveClientProvider({ isRemote: false })).toBe('native')
    expect(resolveClientProvider({})).toBe('native')
  })
})

describe('resolveServerRunning', () => {
  const composed = (host: string, server: string, bridge: string) => ({
    host: { status: host },
    server: { status: server },
    bridge: { status: bridge },
  })

  it('native: reads the raw local scan directly, unchanged from before this fix', async () => {
    const fetchNativeStatus = vi.fn().mockResolvedValue({ running: true })
    const fetchComposedStatus = vi.fn()
    await expect(resolveServerRunning({ isRemote: false }, fetchNativeStatus, fetchComposedStatus))
      .resolves.toBe(true)
    expect(fetchComposedStatus).not.toHaveBeenCalled()

    await expect(
      resolveServerRunning({ isRemote: false }, vi.fn().mockResolvedValue({ running: false }), fetchComposedStatus),
    ).resolves.toBe(false)
  })

  it('native: a failed lookup is unknown (null), not a confident false', async () => {
    const fetchNativeStatus = vi.fn().mockRejectedValue(new Error('network error'))
    await expect(resolveServerRunning({ isRemote: false }, fetchNativeStatus, vi.fn())).resolves.toBeNull()
  })

  it('native: a scanFailed status is unknown (null), never demoted to confirmed-stopped', async () => {
    const fetchNativeStatus = vi.fn().mockResolvedValue({ running: false, scanFailed: true })
    await expect(resolveServerRunning({ isRemote: false }, fetchNativeStatus, vi.fn())).resolves.toBeNull()
  })

  it('docker-managed: a running container is detected via the composed status even though the local scan cannot see it', async () => {
    const fetchNativeStatus = vi.fn().mockResolvedValue({ running: false })
    const fetchComposedStatus = vi.fn().mockResolvedValue(composed('running', 'disconnected', 'offline'))
    await expect(
      resolveServerRunning({ isRemote: false, dockerContainerName: 'pz' }, fetchNativeStatus, fetchComposedStatus),
    ).resolves.toBe(true)
    expect(fetchNativeStatus).not.toHaveBeenCalled()
  })

  it('docker-managed: RCON connected or bridge active is also treated as running, even if the host signal itself is not', async () => {
    await expect(
      resolveServerRunning(
        { dockerContainerName: 'pz' },
        vi.fn(),
        vi.fn().mockResolvedValue(composed('stopped', 'connected', 'offline')),
      ),
    ).resolves.toBe(true)
    await expect(
      resolveServerRunning(
        { dockerContainerName: 'pz' },
        vi.fn(),
        vi.fn().mockResolvedValue(composed('stopped', 'disconnected', 'active')),
      ),
    ).resolves.toBe(true)
  })

  it('docker-managed: confirmed stopped only when every signal positively says so', async () => {
    await expect(
      resolveServerRunning(
        { dockerContainerName: 'pz' },
        vi.fn(),
        vi.fn().mockResolvedValue(composed('stopped', 'disconnected', 'offline')),
      ),
    ).resolves.toBe(false)
  })

  it('FAIL CLOSED: an indeterminate host signal is unknown (null), never demoted to confirmed-stopped', async () => {
    await expect(
      resolveServerRunning(
        { dockerContainerName: 'pz' },
        vi.fn(),
        vi.fn().mockResolvedValue(composed('unknown', 'disconnected', 'offline')),
      ),
    ).resolves.toBeNull()
    await expect(
      resolveServerRunning(
        { isRemote: true },
        vi.fn(),
        vi.fn().mockResolvedValue(composed('not-applicable', 'disconnected', 'offline')),
      ),
    ).resolves.toBeNull()
  })

  it('FAIL CLOSED: the composed-status lookup itself failing is unknown (null), guard stays active -- this is the shape of the actual bug (a call that SUCCEEDS with a wrong answer is the dangerous case, not one that throws, but a throw still must not become a permissive value)', async () => {
    await expect(
      resolveServerRunning({ dockerContainerName: 'pz' }, vi.fn(), vi.fn().mockRejectedValue(new Error('down'))),
    ).resolves.toBeNull()
  })

  it('FAIL CLOSED: no active server at all is unknown (null), not a free pass to save', async () => {
    await expect(resolveServerRunning(null, vi.fn(), vi.fn())).resolves.toBeNull()
    await expect(resolveServerRunning(undefined, vi.fn(), vi.fn())).resolves.toBeNull()
  })
})

describe('resolveServerCardRunning', () => {
  const composed = (host: string, server: string, bridge: string) => ({
    host: { status: host },
    server: { status: server },
    bridge: { status: bridge },
  })

  it('keeps Stop available when the local process scan misses a live active server but RCON is connected', () => {
    expect(
      resolveServerCardRunning(
        { isActive: true },
        { running: false },
        composed('stopped', 'connected', 'offline'),
      ),
    ).toBe(true)
  })

  it('uses the process scan for inactive cards and does not borrow the active server signals', () => {
    expect(
      resolveServerCardRunning(
        { isActive: false },
        { running: false },
        composed('running', 'connected', 'active'),
      ),
    ).toBe(false)
    expect(
      resolveServerCardRunning(
        { isActive: false },
        { running: true },
        null,
      ),
    ).toBe(true)
  })

  it('recognizes a positive host or bridge signal for the active card', () => {
    expect(resolveServerCardRunning({ isActive: true }, null, composed('running', 'disconnected', 'offline'))).toBe(true)
    expect(resolveServerCardRunning({ isActive: true }, null, composed('unknown', 'disconnected', 'active'))).toBe(true)
    expect(resolveServerCardRunning({ isActive: true }, null, composed('stopped', 'disconnected', 'offline'))).toBe(false)
    expect(resolveServerCardRunning({ isActive: true }, null, composed('stopped', 'connecting', 'offline'))).toBeNull()
  })

  it('returns unknown while an active server has no trustworthy status', () => {
    expect(resolveServerCardRunning({ isActive: true }, null, null)).toBeNull()
    expect(resolveServerCardRunning({ isActive: true }, { running: false, stateUnknown: true }, null)).toBeNull()
    expect(resolveServerCardRunning({ isActive: true }, { running: true }, composed('stopped', 'disconnected', 'offline'))).toBe(false)
  })

  it('does not trust the local process scan for an active Docker server', () => {
    expect(
      resolveServerCardRunning(
        { isActive: true, dockerContainerId: 'container-id' },
        { running: true },
        composed('stopped', 'disconnected', 'offline'),
      ),
    ).toBe(false)
    expect(resolveServerCardRunning({ isActive: true, dockerContainerName: 'zomboid-panel' }, { running: true }, null)).toBeNull()
  })
})

describe('deriveDashboardStatus', () => {
  const composed = (host: string, server: string, bridge: string) => ({
    host: { status: host },
    server: { status: server },
    bridge: { status: bridge },
  })

  it('THE LIVE BUG: native provider, plain scan says stopped, RCON is connected -- online must be true, not just hostRunning false', () => {
    const result = deriveDashboardStatus({
      hasServer: true,
      provider: 'native',
      status: { running: false, rcon: { connected: true } },
      composedStatus: composed('stopped', 'connected', 'offline'),
    })
    expect(result.hostRunning).toBe(false)
    expect(result.rconConnected).toBe(true)
    expect(result.online).toBe(true)
  })

  it('native provider, plain scan says stopped, bridge is active -- online is still true via the bridge signal alone', () => {
    const result = deriveDashboardStatus({
      hasServer: true,
      provider: 'native',
      status: { running: false, rcon: { connected: false } },
      composedStatus: composed('stopped', 'disconnected', 'active'),
    })
    expect(result.hostRunning).toBe(false)
    expect(result.online).toBe(true)
  })

  it('native provider, everything genuinely stopped -- online is false, matching hostRunning', () => {
    const result = deriveDashboardStatus({
      hasServer: true,
      provider: 'native',
      status: { running: false, rcon: { connected: false } },
      composedStatus: composed('stopped', 'disconnected', 'offline'),
    })
    expect(result.hostRunning).toBe(false)
    expect(result.online).toBe(false)
  })

  it('native provider, plain scan says running -- hostRunning and online both true, regardless of composedStatus', () => {
    const result = deriveDashboardStatus({
      hasServer: true,
      provider: 'native',
      status: { running: true, rcon: { connected: false } },
      composedStatus: composed('stopped', 'disconnected', 'offline'),
    })
    expect(result.hostRunning).toBe(true)
    expect(result.online).toBe(true)
  })

  it('docker provider (localProcessStatus never applies): host scan cannot see it, but RCON connected still means online -- unchanged behavior, not a regression', () => {
    const result = deriveDashboardStatus({
      hasServer: true,
      provider: 'docker-local',
      status: { running: false, rcon: { connected: true } },
      composedStatus: composed('stopped', 'connected', 'offline'),
    })
    expect(result.hostRunning).toBe(false)
    expect(result.online).toBe(true)
  })

  it('no composedStatus available at all: falls back to the plain status fields exactly as before', () => {
    const withScan = deriveDashboardStatus({
      hasServer: true,
      provider: 'native',
      status: { running: true, rcon: { connected: false } },
      composedStatus: null,
    })
    expect(withScan.hostRunning).toBe(true)
    expect(withScan.online).toBe(true)
    expect(withScan.rconConnected).toBe(false)

    const withoutScan = deriveDashboardStatus({
      hasServer: true,
      provider: 'native',
      status: { running: false, rcon: { connected: false } },
      composedStatus: null,
    })
    expect(withoutScan.hostRunning).toBe(false)
    expect(withoutScan.online).toBe(false)
  })

  it('no active server: everything is false regardless of signals', () => {
    const result = deriveDashboardStatus({
      hasServer: false,
      provider: 'native',
      status: { running: true, rcon: { connected: true } },
      composedStatus: composed('running', 'connected', 'active'),
    })
    expect(result.hostRunning).toBe(false)
    expect(result.online).toBe(false)
  })

  it('native provider, plain scan failed (scanFailed:true) but RCON connected -- hostRunning falls back to composedStatus instead of trusting the failed scan\'s running:false', () => {
    const result = deriveDashboardStatus({
      hasServer: true,
      provider: 'native',
      status: { running: false, scanFailed: true, rcon: { connected: true } },
      composedStatus: composed('running', 'connected', 'offline'),
    })
    expect(result.hostRunning).toBe(true)
    expect(result.online).toBe(true)
  })

  it('native provider, plain scan failed and composedStatus also says stopped -- hostRunning correctly falls through to composedStatus\'s answer, not the failed scan', () => {
    const result = deriveDashboardStatus({
      hasServer: true,
      provider: 'native',
      status: { running: false, scanFailed: true, rcon: { connected: false } },
      composedStatus: composed('stopped', 'disconnected', 'offline'),
    })
    expect(result.hostRunning).toBe(false)
    expect(result.online).toBe(false)
  })

  it('hostUnknown reflects an indeterminate host signal (scan failed), independent of online', () => {
    const result = deriveDashboardStatus({
      hasServer: true,
      provider: 'native',
      status: { running: false, rcon: { connected: false } },
      composedStatus: composed('unknown', 'disconnected', 'offline'),
    })
    expect(result.hostUnknown).toBe(true)
    expect(result.online).toBe(false)
  })
})

describe('waitForServerState', () => {
  it('waits until the requested server state is observed', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce({ servers: [{ id: 7, running: true, pid: '123' }] })
      .mockResolvedValueOnce({ servers: [{ id: 7, running: false, pid: null }] })
    const observed: boolean[] = []

    await expect(waitForServerState(fetchStatus, 7, false, status => observed.push(status.running), { pollMs: 0 }))
      .resolves.toBe(true)

    expect(fetchStatus).toHaveBeenCalledTimes(2)
    expect(observed).toEqual([true, false])
  })

  it('times out when the server never reaches the requested state', async () => {
    const fetchStatus = vi.fn().mockResolvedValue({ servers: [{ id: 7, running: true, pid: '123' }] })

    await expect(waitForServerState(fetchStatus, 7, false, undefined, { timeoutMs: 0, pollMs: 0 }))
      .resolves.toBe(false)
    expect(fetchStatus).toHaveBeenCalledOnce()
  })
})
