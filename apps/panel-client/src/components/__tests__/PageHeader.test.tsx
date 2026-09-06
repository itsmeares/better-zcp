import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from '../PageHeader'

describe('PageHeader', () => {
  it('renders the real title and description passed in', () => {
    render(<PageHeader title="Café Serveur" description="Gérer le serveur" />)
    expect(screen.getByRole('heading', { name: 'Café Serveur' })).toBeInTheDocument()
    expect(screen.getByText('Gérer le serveur')).toBeInTheDocument()
  })

  it('omits the description block entirely when none is given, not an empty paragraph', () => {
    const { container } = render(<PageHeader title="Servers" />)
    expect(container.querySelector('.page-description')).not.toBeInTheDocument()
  })

  it('renders actions content when provided', () => {
    render(<PageHeader title="Servers" actions={<button>Add server</button>} />)
    expect(screen.getByRole('button', { name: 'Add server' })).toBeInTheDocument()
  })

  it('stamps the requested tone as a data attribute for theming', () => {
    const { container } = render(<PageHeader title="Servers" tone="servers" />)
    expect(container.firstChild).toHaveAttribute('data-tone', 'servers')
  })

  it('defaults to the "ops" tone when none is specified', () => {
    const { container } = render(<PageHeader title="Servers" />)
    expect(container.firstChild).toHaveAttribute('data-tone', 'ops')
  })
})
