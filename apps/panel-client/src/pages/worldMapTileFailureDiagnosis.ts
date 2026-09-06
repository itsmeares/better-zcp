export type TileByteSignature =
  | { kind: 'gzip' }
  // An HTML document where an image was expected -- a proxy error page, a
  // login/interstitial page, or a captive portal intercepting the request.
  | { kind: 'html' }
  // A JSON document where an image was expected -- most likely the panel's
  // own server returned one of its error envelopes with the wrong
  // Content-Type, or a route the client believed was the tile route wasn't.
  | { kind: 'json' }
  // Genuine JPEG data (the real magic number: FF D8 FF) -- the bytes ARE an
  // image, so a decode failure here means truncation or corruption, not a
  // wrong payload. This is the one case where comparing against
  // Content-Length actually distinguishes something.
  | { kind: 'jpeg' }
  // Genuine PNG data where a JPEG was expected -- a Content-Type mismatch
  // on the panel's own side, not a network-in-between problem.
  | { kind: 'png' }
  // No bytes at all (an empty response body).
  | { kind: 'empty' }
  // Matches none of the above -- reported as raw hex rather than forced
  // into one of the recognised buckets.
  | { kind: 'unrecognized'; hex: string }

export interface TileFailureDiagnosis {
  signature: TileByteSignature
  looksLikeTruncated: boolean
  receivedBytes: number
  expectedBytes: number | null
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
}

export function classifyTileBytes(bytes: Uint8Array): TileByteSignature {
  if (bytes.length === 0) return { kind: 'empty' }
  const b0 = bytes[0]
  const b1 = bytes.length > 1 ? bytes[1] : undefined
  const b2 = bytes.length > 2 ? bytes[2] : undefined
  const b3 = bytes.length > 3 ? bytes[3] : undefined

  if (b0 === 0x1f && b1 === 0x8b) return { kind: 'gzip' }
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return { kind: 'jpeg' }
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return { kind: 'png' }
  if (b0 === 0x3c && (b1 === 0x21 || b1 === 0x68)) return { kind: 'html' }
  if (b0 === 0x7b || b0 === 0x5b) return { kind: 'json' }
  return { kind: 'unrecognized', hex: bytesToHex(bytes) }
}

export function parseContentLength(contentLengthHeader: string | null): number | null {
  if (contentLengthHeader == null) return null
  if (!/^\d+$/.test(contentLengthHeader)) return null
  return Number(contentLengthHeader)
}

export function diagnoseTileFailure(
  firstBytes: Uint8Array,
  receivedBytes: number,
  contentLengthHeader: string | null,
): TileFailureDiagnosis {
  const expectedBytes = parseContentLength(contentLengthHeader)
  return {
    signature: classifyTileBytes(firstBytes),
    looksLikeTruncated: expectedBytes !== null && receivedBytes < expectedBytes,
    receivedBytes,
    expectedBytes,
  }
}

export interface TileFailureCopyKeys {
  titleKey: string
  descKey: string
  descParams?: Record<string, string | number>
}

export function tileFailureCopyKeys(diagnosis: TileFailureDiagnosis): TileFailureCopyKeys {
  switch (diagnosis.signature.kind) {
    case 'gzip':
      return { titleKey: 'tileFailure.gzipTitle', descKey: 'tileFailure.gzipDesc' }
    case 'html':
      return { titleKey: 'tileFailure.htmlTitle', descKey: 'tileFailure.htmlDesc' }
    case 'json':
      return { titleKey: 'tileFailure.jsonTitle', descKey: 'tileFailure.jsonDesc' }
    case 'png':
      return { titleKey: 'tileFailure.pngTitle', descKey: 'tileFailure.pngDesc' }
    case 'empty':
      return { titleKey: 'tileFailure.emptyTitle', descKey: 'tileFailure.emptyDesc' }
    case 'jpeg':
      return diagnosis.looksLikeTruncated
        ? {
            titleKey: 'tileFailure.truncatedTitle',
            descKey: 'tileFailure.truncatedDesc',
            descParams: { received: diagnosis.receivedBytes, expected: diagnosis.expectedBytes ?? 0 },
          }
        : { titleKey: 'tileFailure.corruptTitle', descKey: 'tileFailure.corruptDesc' }
    case 'unrecognized':
      return {
        titleKey: 'tileFailure.unrecognizedTitle',
        descKey: 'tileFailure.unrecognizedDesc',
        descParams: { hex: diagnosis.signature.hex },
      }
  }
}
