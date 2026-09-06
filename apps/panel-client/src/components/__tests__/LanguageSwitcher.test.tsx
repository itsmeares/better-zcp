import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageSwitcher } from '../LanguageSwitcher'
import i18n, { LANGUAGE_STORAGE_KEY } from '@/i18n'

beforeEach(() => {
  localStorage.clear()
  void i18n.changeLanguage('en')
})
afterEach(() => {
  localStorage.clear()
  void i18n.changeLanguage('en')
})

describe('LanguageSwitcher', () => {
  it("shows the active language's own native name on the trigger", () => {
    render(<LanguageSwitcher />)
    expect(screen.getByText('English')).toBeInTheDocument()
  })

  it('lists every registered language by its native name, including accented ones, when opened', () => {
    render(<LanguageSwitcher />)
    fireEvent.pointerDown(screen.getByRole('button'), { button: 0, ctrlKey: false })
    expect(screen.getByText('Français')).toBeInTheDocument()
  })

  it('picking a language actually switches i18n and persists the choice', () => {
    render(<LanguageSwitcher />)
    fireEvent.pointerDown(screen.getByRole('button'), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByText('Français'))

    expect(i18n.language).toBe('fr')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('fr')
  })

  it('re-renders the trigger with the new native name after switching', async () => {
    render(<LanguageSwitcher />)
    fireEvent.pointerDown(screen.getByRole('button'), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByText('Français'))

    expect(await screen.findByText('Français', { selector: 'span' })).toBeInTheDocument()
  })
})
