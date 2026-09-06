import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ModRow, WorkshopIdChip, WorkshopLinkAction } from '../mods/ModRow'
import { TooltipProvider } from '@/components/ui/tooltip'

describe('WorkshopIdChip', () => {
  it('copies the real workshop id and reports it back via onCopied', async () => {
    const onCopied = vi.fn()
    render(<TooltipProvider><WorkshopIdChip wsId="123456789" onCopied={onCopied} /></TooltipProvider>)

    fireEvent.click(screen.getByRole('button', { name: 'Copy workshop ID 123456789' }))

    await waitFor(() => expect(onCopied).toHaveBeenCalledWith('123456789'))
  })

  it('clicking the chip does not bubble into a parent row click (it would select/open the wrong thing)', async () => {
    const onRowClick = vi.fn()
    const onCopied = vi.fn()
    render(
      <TooltipProvider>
        <div onClick={onRowClick}>
          <WorkshopIdChip wsId="123456789" onCopied={onCopied} />
        </div>
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy workshop ID 123456789' }))
    await waitFor(() => expect(onCopied).toHaveBeenCalled())
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

describe('WorkshopLinkAction', () => {
  it('links to the real Steam Workshop page for the given id, opened in a new tab', () => {
    render(<TooltipProvider><WorkshopLinkAction wsId="987654321" label="Café Mod" /></TooltipProvider>)
    const link = screen.getByRole('link', { name: 'Open workshop page for Café Mod' })
    expect(link).toHaveAttribute('href', 'https://steamcommunity.com/sharedfiles/filedetails/?id=987654321')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('does not bubble into a parent row click', () => {
    const onRowClick = vi.fn()
    render(
      <TooltipProvider>
        <div onClick={onRowClick}>
          <WorkshopLinkAction wsId="1" label="Mod" />
        </div>
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('link'))
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

describe('ModRow', () => {
  it('renders title, meta and actions in their real slots', () => {
    render(
      <ModRow
        title={<span>Café Mod</span>}
        meta={<span>meta info</span>}
        actions={<button>Remove</button>}
      />
    )
    expect(screen.getByText('Café Mod')).toBeInTheDocument()
    expect(screen.getByText('meta info')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('omits the meta line entirely when none is given, not an empty row', () => {
    const { container } = render(<ModRow title={<span>Café Mod</span>} />)
    expect(container.querySelector('.mt-1')).not.toBeInTheDocument()
  })

  it('fires onClick when the row itself is clicked', () => {
    const onClick = vi.fn()
    render(<ModRow title={<span>Café Mod</span>} onClick={onClick} />)
    fireEvent.click(screen.getByText('Café Mod'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('an action button inside the row still stops the row click from also firing, when it manages its own propagation', () => {
    const onRowClick = vi.fn()
    const onAction = vi.fn((e: React.MouseEvent) => e.stopPropagation())
    render(
      <ModRow
        title={<span>Café Mod</span>}
        actions={<button onClick={onAction}>Remove</button>}
        onClick={onRowClick}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })
})
