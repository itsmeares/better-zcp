import { describe, expect, it } from "vite-plus/test"
import { readSseStream } from "./sse"

describe("readSseStream", () => {
  it("frames chunked UTF-8 events with CRLF and ignores heartbeats", async () => {
    const bytes = new TextEncoder().encode(
      'event: mod-scanned\r\ndata: {"modName":"Möđ 😀","progress":50}\r\n\r\n: ping\r\n\r\nevent: complete\r\ndata: {"pairs":[]}\r\n\r\n',
    )
    const utf8Split = bytes.indexOf(0xc3) + 1
    const crlfSplit = bytes.indexOf(0x0d) + 1
    const boundaries = [...new Set([utf8Split, crlfSplit])].sort((a, b) => a - b)
    const chunks: Uint8Array[] = []
    let offset = 0
    for (const boundary of boundaries) {
      chunks.push(bytes.slice(offset, boundary))
      offset = boundary
    }
    chunks.push(bytes.slice(offset))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    const events: Array<{ event: string; data: string }> = []

    await readSseStream(body, (event) => events.push(event))

    expect(events).toEqual([
      { event: "mod-scanned", data: '{"modName":"Möđ 😀","progress":50}' },
      { event: "complete", data: '{"pairs":[]}' },
    ])
  })
})
