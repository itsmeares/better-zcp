import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerReconnectRecovery } from './socketRecovery'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
}

describe('registerReconnectRecovery', () => {
  afterEach(() => {
    setVisibility('visible') // restore jsdom's default between tests
  })

  it('reconnects when the tab becomes visible again', () => {
    setVisibility('hidden')
    const connect = vi.fn()
    registerReconnectRecovery(connect)

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect on a visibilitychange that is still hidden', () => {
    setVisibility('hidden')
    const connect = vi.fn()
    registerReconnectRecovery(connect)

    document.dispatchEvent(new Event('visibilitychange'))

    expect(connect).not.toHaveBeenCalled()
  })

  it('reconnects when the browser reports the network is back online', () => {
    const connect = vi.fn()
    registerReconnectRecovery(connect)

    window.dispatchEvent(new Event('online'))

    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('only reconnects once even if both events fire', () => {
    const connect = vi.fn()
    registerReconnectRecovery(connect)

    window.dispatchEvent(new Event('online'))
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('the returned disposer removes both listeners without ever calling connect', () => {
    const connect = vi.fn()
    const dispose = registerReconnectRecovery(connect)

    dispose()
    window.dispatchEvent(new Event('online'))
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(connect).not.toHaveBeenCalled()
  })

  it('the disposer is safe to call again after recovery already fired', () => {
    const connect = vi.fn()
    const dispose = registerReconnectRecovery(connect)

    window.dispatchEvent(new Event('online'))
    expect(() => dispose()).not.toThrow()
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
