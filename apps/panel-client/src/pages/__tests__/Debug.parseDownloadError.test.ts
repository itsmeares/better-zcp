import { describe, expect, it } from 'vitest'
import { parseDownloadError } from '../Debug'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Debug -- parseDownloadError', () => {
  it('extracts the server error message from a JSON error body', async () => {
    const message = await parseDownloadError(jsonResponse(404, { error: 'Log file not found' }), 'HTTP 404')
    expect(message).toBe('Log file not found')
  })

  it('falls back when the body has no error field', async () => {
    const message = await parseDownloadError(jsonResponse(500, {}), 'HTTP 500')
    expect(message).toBe('HTTP 500')
  })

  it('falls back when the response body is not JSON', async () => {
    const res = new Response('<html>not json</html>', { status: 502, headers: { 'content-type': 'text/html' } })
    const message = await parseDownloadError(res, 'HTTP 502')
    expect(message).toBe('HTTP 502')
  })
})
