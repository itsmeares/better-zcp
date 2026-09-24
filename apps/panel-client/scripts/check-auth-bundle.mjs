import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import path from 'node:path'

const html = readFileSync('dist/index.html', 'utf8')
const preloads = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+\.js)"/g)]
  .map((match) => match[1])

if (preloads.length === 0) throw new Error('No initial JavaScript found')

let rawBytes = 0
let gzipBytes = 0
for (const href of preloads) {
  const assetPath = new URL(href, 'http://panel.local').pathname
  const assetIndex = assetPath.indexOf('/assets/')
  if (assetIndex < 0) throw new Error(`Unexpected preload: ${href}`)
  const bytes = readFileSync(path.join('dist', assetPath.slice(assetIndex + 1)))
  rawBytes += bytes.length
  gzipBytes += gzipSync(bytes).length
  if (/\b(?:charts|Dashboard|DebugPerformanceCharts|App)-/.test(href)) {
    throw new Error(`Authenticated feature preloaded before login: ${href}`)
  }
}

console.log(`Initial auth shell: ${preloads.length} modules, ${(rawBytes / 1024).toFixed(1)} KiB raw, ${(gzipBytes / 1024).toFixed(1)} KiB gzip`)
if (gzipBytes > 500 * 1024) throw new Error('Initial auth shell exceeds 500 KiB gzip')
