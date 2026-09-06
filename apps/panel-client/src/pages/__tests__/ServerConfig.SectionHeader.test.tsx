import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { resolveServerConfigDeepLink, SectionHeader } from '../ServerConfig'

describe('ServerConfig -- SectionHeader', () => {
  it('lets the label and action row wrap onto separate lines', () => {
    const { container } = render(
      <SectionHeader
        label="Server settings"
        sublabel="INI - behavior, network, players"
        action={<button type="button">Save &amp; reload</button>}
      />,
    )
    const header = container.firstElementChild
    expect(header).toHaveClass('flex-wrap')
  })

  it('gives the wrapped action row the full row width below sm, so its own children have room to wrap', () => {
    const { container } = render(
      <SectionHeader
        label="Server settings"
        action={<button type="button">Save &amp; reload</button>}
      />,
    )
    const actionWrapper = container.querySelector('button')?.parentElement
    expect(actionWrapper).toHaveClass('w-full')
    expect(actionWrapper).toHaveClass('sm:w-auto')
  })
})

describe('ServerConfig deep links', () => {
  it('opens the INI tab with a bounded search term', () => {
    expect(resolveServerConfigDeepLink(new URLSearchParams('tab=ini&search=%20Mods%20&unresolved=ArcadiaQOLSafehouse_B42')))
      .toEqual({
        tab: 'ini',
        search: 'Mods',
        unresolved: ['ArcadiaQOLSafehouse_B42'],
        unresolvedTriage: new Map(),
      })
  })

  it('falls back to the INI tab for unknown tab values', () => {
    expect(resolveServerConfigDeepLink(new URLSearchParams('tab=unknown')))
      .toEqual({ tab: 'ini', search: '', unresolved: [], unresolvedTriage: new Map() })
  })
})
