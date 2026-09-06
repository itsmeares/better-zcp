import { describe, it, expect } from 'vitest'
import enServerConfig from '../../locales/en/serverconfig.json'

describe('ServerConfig -- "server is running" banner copy', () => {
  it('does not unconditionally claim changes never reach the running server without a restart', () => {
    expect(enServerConfig.stopServerAlert.description).not.toMatch(
      /won.t reach the running game until the server restarts/i,
    )
  })

  it('has a distinct, honestly-hedged copy for the unknown-state case, not a reused confident claim', () => {
    expect(enServerConfig.stopServerAlert.unknownTitle).toBeTruthy()
    expect(enServerConfig.stopServerAlert.unknownDescription).toBeTruthy()
    expect(enServerConfig.stopServerAlert.unknownTitle).not.toBe(enServerConfig.stopServerAlert.title)
    expect(enServerConfig.stopServerAlert.unknownTitle.toLowerCase()).not.toMatch(/^the server is running/)
  })
})
