import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PasswordInput } from '../PasswordInput'

describe('PasswordInput', () => {
  it('defaults to masked input', () => {
    render(<PasswordInput value="secret" onChange={vi.fn()} label="RCON password" />)
    expect(screen.getByDisplayValue('secret')).toHaveAttribute('type', 'password')
  })

  it('reveals the raw value on toggle, and hides it again on a second click', () => {
    render(<PasswordInput value="secret" onChange={vi.fn()} label="RCON password" />)
    const toggle = screen.getByRole('button', { name: 'Show RCON password' })

    fireEvent.click(toggle)
    expect(screen.getByDisplayValue('secret')).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide RCON password' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Hide RCON password' }))
    expect(screen.getByDisplayValue('secret')).toHaveAttribute('type', 'password')
  })

  it('calls onChange with exactly what was typed, including non-ASCII characters', () => {
    const onChange = vi.fn()
    const { container } = render(<PasswordInput value="" onChange={onChange} label="RCON password" />)
    const input = container.querySelector('input')!
    fireEvent.change(input, { target: { value: 'pâsswörd-日本語' } })
    expect(onChange).toHaveBeenCalledWith('pâsswörd-日本語')
  })

  it('does not leak the raw password into the accessible name of the toggle button', () => {
    render(<PasswordInput value="hunter2" onChange={vi.fn()} label="SFTP password" />)
    // The button is icon-only -- .textContent is always empty regardless of the real
    // accessible name, so it can never catch a leak into aria-label (2026-08-31 bug hunt,
    // Dwight's under-coverage sweep: injecting the password straight into aria-label left
    // the old .textContent assertion green). aria-label IS the accessible name a screen
    // reader announces, so that's what a credential-exposure test has to assert on.
    expect(screen.getByRole('button', { name: /show sftp password/i }).getAttribute('aria-label')).not.toContain('hunter2')
  })
})
