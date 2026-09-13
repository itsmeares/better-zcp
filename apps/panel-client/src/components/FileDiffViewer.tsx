import { useState, useCallback, useRef, useEffect, memo } from 'react'
import {
  ChevronDown,
  FileCode,
  ImageIcon,
  FileQuestion,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import { getAccessToken } from '@/lib/authToken'
import { ApiError } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'

interface DiffLine {
  type: 'context' | 'add' | 'remove'
  text: string
  lineA?: number
  lineB?: number
}

interface DiffHunk {
  startA: number
  startB: number
  countA: number
  countB: number
  lines: DiffLine[]
}

interface TextDiff {
  type: 'text'
  ext: string
  modA: { size: number; lineCount: number }
  modB: { size: number; lineCount: number }
  hunks: DiffHunk[]
  totalAdded: number
  totalRemoved: number
}

interface ImageDiff {
  type: 'image'
  ext: string
  modA: { size: number; base64: string | null }
  modB: { size: number; base64: string | null }
}

interface BinaryDiff {
  type: 'binary' | 'text-too-large'
  ext: string
  modA: { size: number; hash: string | null }
  modB: { size: number; hash: string | null }
}

type DiffResult = TextDiff | ImageDiff | BinaryDiff

const MAX_VISIBLE_HUNKS = 3

interface FileDiffViewerProps {
  file: string
  modAId: string
  modBId: string
  modAName: string
  modBName: string
  severity: 'high' | 'medium' | 'low'
  categoryLabel?: string
  winnerName?: string | null
  loserName?: string | null
  overlap?: {
    kind:
      | 'lua-symbols'
      | 'lua-shadow'
      | 'script-defs'
      | 'clothing-items'
      | 'translation-keys'
    items: string[]
    total: number
  } | null
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function overlapKindLabel(
  kind:
    | 'lua-symbols'
    | 'lua-shadow'
    | 'script-defs'
    | 'clothing-items'
    | 'translation-keys',
): string {
  return (
    (
      {
        'lua-symbols': 'function/event names',
        'lua-shadow': 'symbols',
        'script-defs': 'item/recipe definitions',
        'clothing-items': 'clothing items',
        'translation-keys': 'translation keys',
      } as Record<string, string>
    )[String(kind)] ?? String(kind)
  )
}

function overlapKindShortLabel(
  kind:
    | 'lua-symbols'
    | 'lua-shadow'
    | 'script-defs'
    | 'clothing-items'
    | 'translation-keys',
): string {
  return (
    (
      {
        'lua-symbols': 'symbol',
        'lua-shadow': 'symbol',
        'script-defs': 'definition',
        'clothing-items': 'item',
        'translation-keys': 'key',
      } as Record<string, string>
    )[String(kind)] ?? String(kind)
  )
}

export const FileDiffViewer = memo(function FileDiffViewer({
  file,
  modAId,
  modBId,
  modAName,
  modBName,
  severity,
  categoryLabel,
  winnerName,
  loserName,
  overlap,
}: FileDiffViewerProps) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  const fetchDiff = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ file, modA: modAId, modB: modBId })
      const token = getAccessToken()
      const headers: HeadersInit = {}
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(`/api/mods/conflicts/diff?${params}`, {
        headers,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({}) as { error?: string; code?: string })
        throw new ApiError(body.error || `HTTP ${res.status}`, {
          status: res.status,
          code: body.code,
        })
      }
      const data = await res.json()
      setDiff(data)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(getUserErrorMessage(e, 'Failed to load diff'))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [file, modAId, modBId])

  const handleClick = useCallback(() => {
    if (diff) {
      setExpanded((prev) => !prev)
    } else {
      setExpanded(true)
      fetchDiff()
    }
  }, [diff, fetchDiff])

  return (
    <div className="group">
      <button
        type="button"
        onClick={handleClick}
        aria-expanded={expanded}
        className={`flex items-center gap-2 text-xs py-1.5 px-2 rounded transition-colors duration-100 w-full text-start ${
          expanded ? 'bg-muted/60' : 'hover:bg-muted/40'
        }`}
      >
        <div
          aria-hidden="true"
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            severity === 'high'
              ? 'bg-destructive'
              : severity === 'medium'
                ? 'bg-warning'
                : 'bg-primary/50'
          }`}
        />
        <code className="font-mono text-[11px] flex-1 min-w-0 truncate text-foreground/80">
          {file}
        </code>
        {overlap && overlap.total > 0 && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium ${
              overlap.kind === 'lua-symbols' ||
              overlap.kind === 'script-defs' ||
              overlap.kind === 'clothing-items'
                ? 'bg-destructive/15 text-destructive'
                : 'bg-warning/15 text-warning'
            }`}
            title={
              String(overlap.total) +
              ' overlapping ' +
              String(overlapKindLabel(overlap.kind)) +
              ':\n' +
              String(
                overlap.items.slice(0, 25).join('\n') +
                  (overlap.items.length > 25
                    ? '\n+' + String(overlap.items.length - 25) + ' more'
                    : ''),
              )
            }
          >
            {Number(overlap.total) === 1
              ? String(overlap.total) +
                ' ' +
                String(overlapKindShortLabel(overlap.kind)) +
                ' clash'
              : String(overlap.total) +
                ' ' +
                String(overlapKindShortLabel(overlap.kind)) +
                ' clashes'}
          </span>
        )}
        {overlap && overlap.kind === 'lua-shadow' && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded shrink-0 bg-muted/60 text-muted-foreground"
            title={
              'Both mods ship this Lua file but no symbol names overlap — the loser is fully shadowed but nothing fights for the same name.'
            }
          >
            {'shadowed'}
          </span>
        )}
        {winnerName && loserName && (
          <span
            className="text-[10px] shrink-0 text-muted-foreground/80 max-w-[180px] truncate"
            title={
              String(winnerName) +
              ' wins (loaded last) — ' +
              String(loserName) +
              "'s version is ignored"
            }
          >
            <span className="text-success/80">{winnerName}</span>
            <span className="text-muted-foreground/50"> &gt; </span>
            <span className="text-muted-foreground/60 line-through">
              {loserName}
            </span>
          </span>
        )}
        {categoryLabel && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground shrink-0"
            title={'File type: ' + String(categoryLabel)}
          >
            {categoryLabel}
          </span>
        )}
        {loading ? (
          <Loader2
            aria-hidden="true"
            className="w-3 h-3 animate-spin text-muted-foreground shrink-0"
          />
        ) : (
          <ChevronDown
            aria-hidden="true"
            className={`w-3 h-3 text-muted-foreground/40 shrink-0 transition-transform duration-150 ${
              expanded ? 'rotate-180' : ''
            } ${diff ? 'opacity-100' : 'opacity-40'}`}
          />
        )}
      </button>

      {expanded && (
        <div className="diff-panel-enter ms-5 me-2 mt-1.5 mb-2.5 rounded-md border border-border/50 overflow-hidden bg-background/50">
          {overlap &&
            overlap.total > 0 &&
            overlap.kind !== 'lua-shadow' &&
            overlap.items.length > 0 && (
              <div className="px-3 py-2 border-b border-border/30 bg-muted/20">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">
                  {'Overlapping ' +
                    String(overlapKindLabel(overlap.kind)) +
                    ' (' +
                    String(overlap.total) +
                    ')'}
                </div>
                <div className="flex flex-wrap gap-1">
                  {overlap.items.slice(0, 30).map((item) => (
                    <code
                      key={item}
                      className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning ring-1 ring-warning/30"
                    >
                      {item}
                    </code>
                  ))}
                  {overlap.items.length > 30 && (
                    <span className="text-[10px] text-muted-foreground/60 self-center">
                      {'+' + String(overlap.items.length - 30) + ' more'}
                    </span>
                  )}
                </div>
                {overlap.kind === 'translation-keys' && (
                  <div className="text-[10px] text-muted-foreground/60 mt-1.5 leading-relaxed">
                    {
                      'Translation files merge across mods — only these specific keys actually clash. Other keys in the diff coexist fine.'
                    }
                  </div>
                )}
              </div>
            )}
          {overlap && overlap.kind === 'lua-shadow' && (
            <div className="px-3 py-2 border-b border-border/30 bg-muted/20 text-[10px] text-muted-foreground/70 leading-relaxed">
              {
                'Both mods ship this Lua file but no symbol names overlap — the loser is fully shadowed but nothing fights for the same name.'
              }
            </div>
          )}
          {loading && (
            <div
              aria-busy="true"
              className="flex items-center justify-center py-6 text-muted-foreground text-xs"
            >
              <Loader2
                aria-hidden="true"
                className="w-3.5 h-3.5 animate-spin me-2"
              />{' '}
              {'Comparing files...'}
            </div>
          )}
          {error && (
            <div className="p-3 text-xs text-destructive flex items-center gap-2">
              <span className="flex-1 min-w-0 break-words" dir="auto">
                {error}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  fetchDiff()
                }}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-1 focus-visible:ring-ring rounded-sm outline-none"
                title={'Retry'}
                aria-label={'Retry file comparison'}
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            </div>
          )}
          {diff && diff.type === 'text' && (
            <TextDiffView diff={diff} modAName={modAName} modBName={modBName} />
          )}
          {diff && diff.type === 'image' && (
            <ImageDiffView
              diff={diff}
              modAName={modAName}
              modBName={modBName}
              file={file}
            />
          )}
          {diff &&
            (diff.type === 'binary' || diff.type === 'text-too-large') && (
              <BinaryDiffView
                diff={diff}
                modAName={modAName}
                modBName={modBName}
              />
            )}
        </div>
      )}
    </div>
  )
})

function TextDiffView({
  diff,
  modAName,
  modBName,
}: {
  diff: TextDiff
  modAName: string
  modBName: string
}) {
  const [showFull, setShowFull] = useState(false)
  const maxHunks = showFull
    ? diff.hunks.length
    : Math.min(diff.hunks.length, MAX_VISIBLE_HUNKS)
  const truncated = diff.hunks.length > MAX_VISIBLE_HUNKS && !showFull

  return (
    <div>
      <div className="flex items-center gap-3 px-3 py-1.5 bg-muted/30 border-b border-border/30 text-[11px] text-muted-foreground">
        <FileCode aria-hidden="true" className="w-3 h-3 shrink-0" />
        <span
          className="truncate max-w-[80px] sm:max-w-[120px]"
          title={modAName}
        >
          {modAName}
        </span>
        <span className="text-muted-foreground/70">
          {'(' + String(diff.modA.lineCount) + ' lines)'}
        </span>
        <span className="text-muted-foreground/70">→</span>
        <span
          className="truncate max-w-[80px] sm:max-w-[120px]"
          title={modBName}
        >
          {modBName}
        </span>
        <span className="text-muted-foreground/70">
          {'(' + String(diff.modB.lineCount) + ' lines)'}
        </span>
        <span className="ms-auto shrink-0 tabular-nums">
          <span className="text-success">+{diff.totalAdded}</span>{' '}
          <span className="text-destructive">-{diff.totalRemoved}</span>
        </span>
      </div>

      <div className="diff-code overflow-x-auto text-[11px] font-mono leading-[1.6] max-h-[250px] sm:max-h-[400px] overflow-y-auto">
        {diff.hunks.slice(0, maxHunks).map((hunk, hIdx) => (
          <div key={hIdx}>
            {hIdx > 0 && (
              <div className="px-3 py-0.5 text-[11px] text-muted-foreground/50 select-none border-t border-dashed border-border/20">
                ···
              </div>
            )}
            {hunk.lines.map((line, lIdx) => (
              <div
                key={`${hIdx}-${lIdx}`}
                className={`diff-line flex ${
                  line.type === 'add'
                    ? 'bg-success/8 diff-line-add'
                    : line.type === 'remove'
                      ? 'bg-destructive/8 diff-line-remove'
                      : ''
                }`}
              >
                <span className="diff-gutter w-8 sm:w-[52px] shrink-0 text-end pe-2 text-muted-foreground/40 select-none border-e border-border/20">
                  {line.type === 'remove' && line.lineA != null
                    ? line.lineA
                    : ''}
                  {line.type === 'context' && line.lineA != null
                    ? line.lineA
                    : ''}
                </span>
                <span className="diff-gutter w-8 sm:w-[52px] shrink-0 text-end pe-2 text-muted-foreground/40 select-none border-e border-border/20">
                  {line.type === 'add' && line.lineB != null ? line.lineB : ''}
                  {line.type === 'context' && line.lineB != null
                    ? line.lineB
                    : ''}
                </span>
                <span
                  className={`w-4 shrink-0 text-center select-none ${
                    line.type === 'add'
                      ? 'text-success/60'
                      : line.type === 'remove'
                        ? 'text-destructive/60'
                        : 'text-transparent'
                  }`}
                >
                  {line.type === 'add'
                    ? '+'
                    : line.type === 'remove'
                      ? '-'
                      : ' '}
                </span>
                <span className="flex-1 min-w-0 whitespace-pre pe-3 text-foreground/80">
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        ))}

        {truncated && (
          <button
            onClick={() => setShowFull(true)}
            aria-expanded={showFull}
            className="w-full text-center py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors border-t border-border/20 focus-visible:ring-1 focus-visible:ring-ring outline-none"
          >
            {Number(diff.hunks.length - MAX_VISIBLE_HUNKS) === 1
              ? 'Show ' +
                String(diff.hunks.length - MAX_VISIBLE_HUNKS) +
                ' more section...'
              : 'Show ' +
                String(diff.hunks.length - MAX_VISIBLE_HUNKS) +
                ' more sections...'}
          </button>
        )}
      </div>
    </div>
  )
}

function ImageDiffView({
  diff,
  modAName,
  modBName,
  file,
}: {
  diff: ImageDiff
  modAName: string
  modBName: string
  file: string
}) {
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-2">
        <ImageIcon aria-hidden="true" className="w-3 h-3" />
        {'Image comparison'}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground truncate">
            {modAName} ({formatSize(diff.modA.size)})
          </p>
          {diff.modA.base64 ? (
            <img
              src={`data:image/${diff.ext.replace('.', '')};base64,${diff.modA.base64}`}
              alt={`${modAName} version of ${file}`}
              loading="lazy"
              className="max-h-32 rounded border border-border/30 bg-[repeating-conic-gradient(rgba(128,128,128,0.1)_0%_25%,transparent_0%_50%)] bg-[length:12px_12px]"
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = 'none'
              }}
            />
          ) : (
            <div className="h-20 rounded border border-border/30 flex items-center justify-center text-[11px] text-muted-foreground">
              {'Too large to preview'}
            </div>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground truncate">
            {modBName} ({formatSize(diff.modB.size)})
          </p>
          {diff.modB.base64 ? (
            <img
              src={`data:image/${diff.ext.replace('.', '')};base64,${diff.modB.base64}`}
              alt={`${modBName} version of ${file}`}
              loading="lazy"
              className="max-h-32 rounded border border-border/30 bg-[repeating-conic-gradient(rgba(128,128,128,0.1)_0%_25%,transparent_0%_50%)] bg-[length:12px_12px]"
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = 'none'
              }}
            />
          ) : (
            <div className="h-20 rounded border border-border/30 flex items-center justify-center text-[11px] text-muted-foreground">
              {'Too large to preview'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BinaryDiffView({
  diff,
  modAName,
  modBName,
}: {
  diff: BinaryDiff
  modAName: string
  modBName: string
}) {
  return (
    <div className="p-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2 mb-2">
        <FileQuestion aria-hidden="true" className="w-3 h-3" />
        {diff.type === 'text-too-large'
          ? 'File too large to compare inline'
          : "Binary file — can't show inline comparison"}
      </div>
      <div className="grid grid-cols-2 gap-3 text-[11px] leading-relaxed">
        <div>
          <p className="font-medium text-foreground/80">{modAName}</p>
          <p>
            {formatSize(diff.modA.size)}
            {diff.modA.hash && ` · ${diff.modA.hash.slice(0, 8)}…`}
          </p>
        </div>
        <div>
          <p className="font-medium text-foreground/80">{modBName}</p>
          <p>
            {formatSize(diff.modB.size)}
            {diff.modB.hash && ` · ${diff.modB.hash.slice(0, 8)}…`}
          </p>
        </div>
      </div>
    </div>
  )
}
