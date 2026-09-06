import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SandboxSettingRow } from '../ServerConfig'
import type { SandboxSetting } from '@/lib/serverConfigSchema'

// Runtime belt-and-braces for the enum-audit class of bug: PZ can ship a new
// select option before this panel's schema regenerates against it (exactly
// what happened with MetaEvent -- PZ has 3 options, the panel only offered
// 2). The save path never coerces an unrecognized value away (confirmed
// during the audit), so the value survives; what was missing was telling
// the operator, instead of a silent blank Select. See
// serverConfigSchema.ts's getUnrecognizedSandboxOptionWarning and the
// pzGroundTruth drift test that's supposed to stop new instances of this at
// the schema level -- this is the layer that still needs to work even when
// that gate is stale (PZ ships between two regenerations of the fixture).

const META_EVENT: SandboxSetting = {
  key: 'MetaEvent',
  label: 'Meta Events',
  description: 'Distant gunshots, screams, etc.',
  type: 'select',
  options: [
    { value: 1, label: 'Never' },
    { value: 2, label: 'Sometimes' },
    { value: 3, label: 'Often' },
  ],
  default: 2,
  category: 'survival',
}

describe('ServerConfig -- unrecognized sandbox select value', () => {
  it('shows the original key without adding its internal section prefix', () => {
    const setting: SandboxSetting = {
      ...META_EVENT,
      key: 'Strength',
      section: 'ZombieLore',
    }
    const { container } = render(<SandboxSettingRow setting={setting} value={2} onChange={vi.fn()} />)
    expect(container.querySelector('code')).toHaveTextContent('Strength')
    expect(container.querySelector('code')).not.toHaveTextContent('ZombieLore.Strength')
  })

  it('shows a warning when the live value has no matching option', () => {
    render(<SandboxSettingRow setting={META_EVENT} value={5} onChange={vi.fn()} />)
    expect(screen.getByText(/does not recognize/i)).toBeInTheDocument()
    expect(screen.getByText('5 (?)')).toBeInTheDocument()
  })

  it('shows no warning when the live value matches a real option', () => {
    render(<SandboxSettingRow setting={META_EVENT} value={2} onChange={vi.fn()} />)
    expect(screen.queryByText(/does not recognize/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/\(\?\)/)).not.toBeInTheDocument()
  })

  it('shows no warning for a non-select setting, regardless of value', () => {
    const numberSetting: SandboxSetting = {
      key: 'StartYear',
      label: 'Start Year',
      description: 'Which year the game starts in.',
      type: 'number',
      default: 1,
      category: 'time',
    }
    render(<SandboxSettingRow setting={numberSetting} value={999} onChange={vi.fn()} />)
    expect(screen.queryByText(/does not recognize/i)).not.toBeInTheDocument()
  })
})
