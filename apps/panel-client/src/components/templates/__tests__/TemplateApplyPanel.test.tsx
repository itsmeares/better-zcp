import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TemplateApplyPanel } from '../TemplateApplyPanel'

const baseProps = {
  scopeIni: true,
  scopeSandbox: true,
  onScopeIniChange: vi.fn(),
  onScopeSandboxChange: vi.fn(),
  applying: false,
  applyError: null,
  applyResult: null,
  canManage: true,
  canApply: true,
  onApply: vi.fn(),
  onClose: vi.fn(),
}

describe('TemplateApplyPanel', () => {
  it.each([true, null])('disables apply when running state is %s', (running) => {
    render(<TemplateApplyPanel {...baseProps} running={running} />)

    const applyButton = screen.getByRole('button', { name: 'Apply Template' })
    expect(applyButton).toBeDisabled()
    fireEvent.click(applyButton)
    expect(baseProps.onApply).not.toHaveBeenCalled()
  })

  it('enables apply only when the server is verified stopped', () => {
    render(<TemplateApplyPanel {...baseProps} running={false} />)

    expect(screen.getByRole('button', { name: 'Apply Template' })).toBeEnabled()
  })

  it('renders no mutation controls for viewers', () => {
    const { container } = render(
      <TemplateApplyPanel {...baseProps} running={false} canManage={false} />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
