import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from '@/lib/routerCompat'
import { ScrollToTop } from '../ScrollToTop'

function PageA() {
  const navigate = useNavigate()
  return <button onClick={() => navigate('/b')}>go to b</button>
}

function RoutedContent() {
  const { pathname } = useLocation()
  return <><ScrollToTop /><main>{pathname === '/a' ? <PageA /> : <div>page b</div>}</main></>
}

function App() {
  return (
    <MemoryRouter initialEntries={['/a']}>
      <RoutedContent />
    </MemoryRouter>
  )
}

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn()
})

describe('ScrollToTop', () => {
  it('scrolls the main content area (not window) on the initial route', () => {
    render(<App />)
    const main = document.querySelector('main')!
    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })

  it('scrolls again on every subsequent route change', () => {
    render(<App />)
    const main = document.querySelector('main')!
    vi.mocked(main.scrollTo).mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'go to b' }))

    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })

  it('does not throw when no <main> element exists in the tree', () => {
    expect(() =>
      render(
        <MemoryRouter initialEntries={['/a']}>
          <ScrollToTop />
        </MemoryRouter>
      )
    ).not.toThrow()
  })
})
