export type SseEvent = { event: string; data: string }

export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let event = ""
  let data: string[] = []

  const dispatch = () => {
    if (data.length) onEvent({ event: event || "message", data: data.join("\n") })
    event = ""
    data = []
  }
  const processLine = (line: string) => {
    if (!line) return dispatch()
    if (line.startsWith(":")) return
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = (colon < 0 ? "" : line.slice(colon + 1)).replace(/^ /, "")
    if (field === "event") event = value
    if (field === "data") data.push(value)
  }
  const processLines = (final = false) => {
    let start = 0
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i]
      if (char !== "\r" && char !== "\n") continue
      if (char === "\r" && i === buffer.length - 1 && !final) break
      processLine(buffer.slice(start, i))
      if (char === "\r" && buffer[i + 1] === "\n") i++
      start = i + 1
    }
    buffer = buffer.slice(start)
    if (final && buffer) {
      processLine(buffer)
      buffer = ""
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      processLines()
    }
    buffer += decoder.decode()
    processLines(true)
    dispatch()
  } finally {
    reader.releaseLock()
  }
}
