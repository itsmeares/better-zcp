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
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47)
    return { kind: 'png' }
  if (b0 === 0x3c && (b1 === 0x21 || b1 === 0x68)) return { kind: 'html' }
  if (b0 === 0x7b || b0 === 0x5b) return { kind: 'json' }
  return { kind: 'unrecognized', hex: bytesToHex(bytes) }
}

export function parseContentLength(
  contentLengthHeader: string | null,
): number | null {
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

export interface TileFailureCopy {
  title: string
  description: string
}

export function tileFailureCopy(
  diagnosis: TileFailureDiagnosis,
): TileFailureCopy {
  switch (diagnosis.signature.kind) {
    case 'gzip':
      return {
        title: 'Map tile arrived still compressed',
        description:
          "This tile's data reached the browser still gzip-compressed instead of being decompressed automatically. This usually means a reverse proxy in front of the panel is stripping or mishandling the Content-Encoding header.",
      }
    case 'html':
      return {
        title: 'An HTML page arrived instead of a map tile',
        description:
          'A proxy error, login page, or network sign-in page may have intercepted the request.',
      }
    case 'json':
      return {
        title: 'The panel returned an error instead of a map tile',
        description:
          "The response was JSON rather than image data, which points to a problem on the panel's side.",
      }
    case 'png':
      return {
        title: 'A PNG image arrived where a JPEG was expected',
        description:
          'The response is an image, but not in the format the panel expected.',
      }
    case 'empty':
      return {
        title: 'Map tile arrived empty',
        description:
          'No data came back for this tile. This usually points to a network or proxy issue.',
      }
    case 'jpeg':
      return diagnosis.looksLikeTruncated
        ? {
            title: 'Map tile was cut short in transit',
            description: `Only ${diagnosis.receivedBytes} of ${diagnosis.expectedBytes ?? 0} bytes arrived. The connection was cut short in transit.`,
          }
        : {
            title: 'Map tile data is corrupted',
            description:
              "The image arrived complete but couldn't be decoded. Try Refresh.",
          }
    case 'unrecognized':
      return {
        title: 'Map tile arrived as unrecognized data',
        description: `Raw bytes: ${diagnosis.signature.hex}`,
      }
  }
}
