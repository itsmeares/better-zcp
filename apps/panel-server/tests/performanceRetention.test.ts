import { expect, it } from 'vitest'
import { recentPerformanceHistory } from '../database/init.ts'

it('keeps only valid snapshots from the last 24 hours and caps one-minute samples', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z')
  const entry = (time: number) => ({ timestamp: new Date(time).toISOString() })
  const history = [
    entry(now - 24 * 60 * 60 * 1000 - 1),
    ...Array.from({ length: 1442 }, (_, i) => entry(now - (1441 - i) * 60_000)),
    { timestamp: 'invalid' },
    entry(now + 1),
  ]
  const kept = recentPerformanceHistory(history, now)
  expect(kept).toHaveLength(1440)
  expect(kept[0].timestamp).toBe(entry(now - 1439 * 60_000).timestamp)
  expect(kept.at(-1)?.timestamp).toBe(entry(now).timestamp)
})
