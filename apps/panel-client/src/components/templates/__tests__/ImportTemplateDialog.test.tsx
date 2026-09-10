import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ImportTemplateDialog } from '../ImportTemplateDialog'
import en from '../../../locales/en/templateImportDialog.json'

function fileWithReadFailure(): File {
  const file = new File([], 'template.pztemplate.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', {
    value: () => Promise.reject(new Error('')),
  })
  return file
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ImportTemplateDialog file reads', () => {
  it('shows an error when the selected file cannot be read', async () => {
    render(<ImportTemplateDialog open onClose={vi.fn()} onImported={vi.fn()} />)

    fireEvent.change(fileInput(), { target: { files: [fileWithReadFailure()] } })

    await waitFor(() => expect(screen.getByText(en.failedToReadFile)).toBeInTheDocument())
    expect(screen.getByText(en.importFailedTitle)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(en.pastePlaceholder)).toHaveValue('')
  })
})
