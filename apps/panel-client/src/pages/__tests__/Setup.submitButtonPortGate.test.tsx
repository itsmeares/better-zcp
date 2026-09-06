import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Setup from '../Setup'
import enSetup from '../../locales/en/setup.json'

// jsdom has no ResizeObserver -- Radix's Checkbox (rendered on this page for
// "Remember me") needs one to mount at all.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

// bug-hunt-2026-08-31: the submit button's disabled expression checked
// loading/setupToken/usernameValid/passwordLongEnough/passwordsMatch but
// omitted panelPortValid, even though handleSubmit's own validation (and
// every OTHER field, including panelPortValid's siblings) blocks submission
// on it. Every other invalid field pre-emptively disables the button;
// an out-of-range port alone left it enabled, so the operator only found
// out it was rejected after clicking and seeing the error -- unlike every
// other validation failure on this form.
const setupFn = vi.fn()

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ setup: setupFn }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function fillValidFormExceptPort() {
  fireEvent.change(screen.getByLabelText(enSetup.setupToken.label), { target: { value: 'a-real-token' } })
  fireEvent.change(screen.getByLabelText(enSetup.password.label), { target: { value: 'correct-horse' } })
  fireEvent.change(screen.getByLabelText(enSetup.confirmPassword.label), { target: { value: 'correct-horse' } })
}

function renderSetup() {
  return render(
    <TooltipProvider>
      <Setup />
    </TooltipProvider>,
  )
}

describe('Setup.tsx: submit button disabled state matches handleSubmit validation', () => {
  it('disables Submit for an out-of-range panel port, same as it does for every other invalid field', () => {
    renderSetup()
    fillValidFormExceptPort()

    const submitButton = screen.getByRole('button', { name: enSetup.submit })
    // Default panelPort ('3001') is valid -- confirm the button is enabled
    // with everything else filled in, so the next assertion isolates the
    // port field specifically.
    expect(submitButton).not.toBeDisabled()

    fireEvent.change(screen.getByLabelText(enSetup.panelPort.label), { target: { value: '80' } })

    expect(submitButton).toBeDisabled()
  })

  it('re-enables Submit once the port is back in range', () => {
    renderSetup()
    fillValidFormExceptPort()

    const submitButton = screen.getByRole('button', { name: enSetup.submit })
    fireEvent.change(screen.getByLabelText(enSetup.panelPort.label), { target: { value: '80' } })
    expect(submitButton).toBeDisabled()

    fireEvent.change(screen.getByLabelText(enSetup.panelPort.label), { target: { value: '8080' } })
    expect(submitButton).not.toBeDisabled()
  })
})
