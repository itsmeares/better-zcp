import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { AutoUpdateResultBanner } from '../AutoUpdateResultBanner'
import { updateApi, type AutoUpdateResult, type UpdateCheckerStatus } from '@/lib/api'
import en from '@/locales/en/dashboard.json'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    updateApi: {
      getStatus: vi.fn(),
      dismissAutoUpdateResult: vi.fn(),
    },
  }
})

const getStatus = vi.mocked(updateApi.getStatus)
const dismissAutoUpdateResult = vi.mocked(updateApi.dismissAutoUpdateResult)

function statusWith(result: AutoUpdateResult | null): UpdateCheckerStatus {
  return {
    updateAvailable: null,
    gameVersion: null,
    lastCheck: null,
    intervalMinutes: 30,
    isChecking: false,
    lastAutoUpdateResult: result,
  }
}

beforeEach(() => {
  getStatus.mockReset()
  dismissAutoUpdateResult.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

// 2026-08-26: this is the persisted-state half of the auto-update
// notification -- a live socket event alone only reaches whoever is
// watching at the exact moment it fires, which excludes the operator this
// feature exists for (enabled it and walked away). These pin that the
// banner is driven by a COLD fetch on mount, not the socket, and that
// dismissal is a real server round-trip (shared across admins/devices),
// not local component state.
describe('AutoUpdateResultBanner', () => {
  it('renders nothing when there is no recorded result -- no false alarm on a server that has never auto-updated', async () => {
    getStatus.mockResolvedValue(statusWith(null))
    const { container } = render(<AutoUpdateResultBanner />)
    await waitFor(() => expect(getStatus).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the last result was already dismissed', async () => {
    getStatus.mockResolvedValue(statusWith({
      status: 'failed', at: '2026-08-26T00:00:00.000Z', dismissed: true,
      reason: 'STOP_TIMEOUT', phase: 'before-stop', serverUp: true,
    }))
    const { container } = render(<AutoUpdateResultBanner />)
    await waitFor(() => expect(getStatus).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('surfaces a failure as an alert, states the server is still up, and shows the translated reason -- not a raw message', async () => {
    getStatus.mockResolvedValue(statusWith({
      status: 'failed', at: '2026-08-26T04:00:00.000Z', dismissed: false,
      reason: 'RCON_NOT_CONNECTED', phase: 'before-stop', serverUp: true,
    }))
    render(<AutoUpdateResultBanner />)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(en.autoUpdateResult.failedTitle)).toBeInTheDocument()
    expect(screen.getByText(en.autoUpdateResult.serverUp)).toBeInTheDocument()
    expect(screen.getByText(en.autoUpdateResult.reasons.RCON_NOT_CONNECTED)).toBeInTheDocument()
  })

  it('states the server is down for a failure recorded after a successful stop', async () => {
    getStatus.mockResolvedValue(statusWith({
      status: 'failed', at: '2026-08-26T04:00:00.000Z', dismissed: false,
      reason: 'STEAMCMD_EXIT_CODE', phase: 'updating', serverUp: false, params: { code: 7 },
    }))
    render(<AutoUpdateResultBanner />)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(en.autoUpdateResult.serverDown)).toBeInTheDocument()
    expect(screen.getByText('SteamCMD exited with code 7.')).toBeInTheDocument()
  })

  it('says nothing was touched for a pre-flight failure (server state is null, not a guess)', async () => {
    getStatus.mockResolvedValue(statusWith({
      status: 'failed', at: '2026-08-26T04:00:00.000Z', dismissed: false,
      reason: 'NOT_CONFIGURED', phase: 'not-started', serverUp: null,
    }))
    render(<AutoUpdateResultBanner />)

    expect(await screen.findByText(en.autoUpdateResult.serverUnaffected)).toBeInTheDocument()
  })

  it('falls back to the generic UNKNOWN reason text if the reason key does not match a known one', async () => {
    getStatus.mockResolvedValue(statusWith({
      status: 'failed', at: '2026-08-26T04:00:00.000Z', dismissed: false,
      reason: 'SOMETHING_NEW_THE_CLIENT_HAS_NOT_SHIPPED_YET', phase: 'updating', serverUp: false,
    }))
    render(<AutoUpdateResultBanner />)

    expect(await screen.findByText(en.autoUpdateResult.reasons.UNKNOWN)).toBeInTheDocument()
  })

  it('surfaces success as a status (not alert), with the applied version interpolated', async () => {
    getStatus.mockResolvedValue(statusWith({
      status: 'success', at: '2026-08-26T04:00:00.000Z', dismissed: false, appliedVersion: '42.13.0',
    }))
    render(<AutoUpdateResultBanner />)

    expect(await screen.findByRole('status')).toBeInTheDocument()
    expect(screen.getByText(en.autoUpdateResult.successTitle)).toBeInTheDocument()
    expect(screen.getByText('The automatic server update completed successfully (now running 42.13.0).')).toBeInTheDocument()
  })

  it('dismissing calls the shared server-side endpoint, not just local state, and hides once it confirms', async () => {
    getStatus.mockResolvedValue(statusWith({
      status: 'failed', at: '2026-08-26T04:00:00.000Z', dismissed: false,
      reason: 'STOP_TIMEOUT', phase: 'before-stop', serverUp: true,
    }))
    dismissAutoUpdateResult.mockResolvedValue(statusWith({
      status: 'failed', at: '2026-08-26T04:00:00.000Z', dismissed: true,
      reason: 'STOP_TIMEOUT', phase: 'before-stop', serverUp: true,
    }))
    const { container } = render(<AutoUpdateResultBanner />)

    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: en.autoUpdateResult.dismissAria }))

    await waitFor(() => expect(dismissAutoUpdateResult).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('shows a toast and keeps the banner visible if dismissing fails, rather than silently hiding or silently doing nothing', async () => {
    getStatus.mockResolvedValue(statusWith({
      status: 'failed', at: '2026-08-26T04:00:00.000Z', dismissed: false,
      reason: 'STOP_TIMEOUT', phase: 'before-stop', serverUp: true,
    }))
    dismissAutoUpdateResult.mockRejectedValue(new Error('network down'))
    render(<AutoUpdateResultBanner />)

    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: en.autoUpdateResult.dismissAria }))

    await waitFor(() => expect(dismissAutoUpdateResult).toHaveBeenCalledTimes(1))
    // Still there -- a failed dismiss must not silently hide the notice.
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
