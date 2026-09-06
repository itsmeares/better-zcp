import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MountDiscoveryBanner } from '../MountDiscoveryBanner'
import type { DiscoveredMount } from '@/lib/api'

const mount: DiscoveredMount = {
  installPath: '/pz-server',
  dataPath: '/pz-data',
  source: 'known-path',
  serverNames: ['servertest'],
  hasStartScript: true,
  hasPanelBridge: false,
}

describe('MountDiscoveryBanner', () => {
  beforeEach(() => localStorage.clear())

  it('passes the discovered mount to the add action', () => {
    const onConnect = vi.fn()
    render(<MountDiscoveryBanner mount={mount} onConnect={onConnect} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(onConnect).toHaveBeenCalledWith(mount)
  })

  it('remembers dismissal for the install path', () => {
    render(<MountDiscoveryBanner mount={mount} onConnect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss discovered install' }))

    expect(screen.queryByText('PZ install')).not.toBeInTheDocument()
    expect(localStorage.getItem(`pz-mount-discovery-dismissed-${mount.installPath}`)).toBe('true')
  })
})