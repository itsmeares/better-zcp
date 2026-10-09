export interface ParsedLogLine {
  type: 'LOG' | 'WARN' | 'ERROR' | 'DEBUG' | 'INFO' | 'UNKNOWN'
  category: string
  message: string
  raw: string
  time?: string
}

function formatLogTime(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs) || epochMs < 1_000_000_000_000) return undefined
  const d = new Date(epochMs)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':')
}

const JAVA_FAILURE = /^(java\.|kotlin\.|zombie\.|com\.|org\.|at\s+\S+\.|Exception in thread|Caused by:|\S+(Exception|Error)(:|\s|$))/i
const STACK_LINE = /^(\s*at\s+\S+|Caused by:|\.{3}\s+\d+ more|Exception in thread)/

/** Splits a Project Zomboid console line (`LOG : General f:0, t:1700000000000> text`) into its parts. */
export function parseLogLine(line: string): ParsedLogLine {
  const trimmed = line.trim()
  if (!trimmed) return { type: 'UNKNOWN', category: '', message: '', raw: line }

  const match = trimmed.match(/^(LOG|WARN|ERROR|DEBUG|INFO)\s*:\s*(\w+)(?:[^>]*?\bt:(\d+))?[^>]*>\s*(.+)$/i)
  if (match) {
    const message = match[4]
    let type = match[1].toUpperCase() as ParsedLogLine['type']
    // The game logs many Java exceptions at LOG level.
    if (type === 'LOG' && JAVA_FAILURE.test(message)) type = 'ERROR'
    return { type, category: match[2], message, raw: line, time: match[3] ? formatLogTime(Number(match[3])) : undefined }
  }

  for (const type of ['ERROR', 'WARN', 'LOG'] as const) {
    if (trimmed.startsWith(type)) {
      return { type, category: '', message: trimmed.replace(new RegExp(`^${type}\\s*:?\\s*`, 'i'), ''), raw: line }
    }
  }
  if (STACK_LINE.test(trimmed)) return { type: 'ERROR', category: '', message: trimmed, raw: line }
  return { type: 'UNKNOWN', category: '', message: trimmed, raw: line }
}

/** Lines the game repeats constantly that say nothing useful to an admin. */
export const NOISE_PATTERNS = [
  /moveZombie: There are no zombies/i,
  /ItemPickInfo -> cannot get ID for container/i,
  /IsoThumpable not found on square/i,
  /SpriteConfig\.initObjectInfo.*Invalid SpriteConfig/i,
  /MOWoodenWalFrame\.lua: replacing isoObject/i,
  /OreVein\{startPoint/i,
  /SkeletonBone not resolved for bone/i,
  /action was null, object: null/i,
  /Could not find item type for/i,
  /Canceled loading wrong transition/i,
]

export const isNoise = (line: string) => NOISE_PATTERNS.some((pattern) => pattern.test(line))
