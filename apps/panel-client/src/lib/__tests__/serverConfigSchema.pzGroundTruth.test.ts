import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SANDBOX_SCHEMA } from '../serverConfigSchema'


const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.resolve(__dirname, '../__fixtures__/pzSandboxGroundTruth.json')

const EXPECTED_SETTING_COUNT = 80

type FixtureOption = { value: number; en: string | null }
type FixtureSetting = { key: string; category: string; default: number | boolean | string | null; options: FixtureOption[] }
type Fixture = { settings: Record<string, FixtureSetting> }

function loadFixture(): Fixture | null {
  if (!fs.existsSync(FIXTURE_PATH)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.settings || typeof parsed.settings !== 'object') return null
    return parsed as Fixture
  } catch {
    return null
  }
}

const fixture = loadFixture()
const fixtureEntries = fixture ? Object.entries(fixture.settings) : []

function findSchemaEntry(f: FixtureSetting) {
  return SANDBOX_SCHEMA.find((s) => s.key === f.key && s.category === f.category)
}

describe('SANDBOX_SCHEMA vs Project Zomboid ground truth (drift gate)', () => {
  it('the fixture exists, is valid JSON, and has a non-empty settings map', () => {
    expect(
      fixture,
      `ground-truth fixture missing, unparseable, or malformed at ${FIXTURE_PATH} -- ` +
        `run: node scripts/extract-pz-sandbox-ground-truth.mjs`,
    ).not.toBeNull()
    expect(fixtureEntries.length, 'fixture has zero settings -- this gate would check nothing').toBeGreaterThan(0)
  })

  it(`compared exactly ${EXPECTED_SETTING_COUNT} settings (the known resolved denominator)`, () => {
    expect(
      fixtureEntries.length,
      'the number of PZ-resolved settings changed -- investigate the join before updating this number ' +
        '(a silent drop, e.g. 269 -> 3, must fail here, not pass quietly)',
    ).toBe(EXPECTED_SETTING_COUNT)
  })

  it('every fixtured setting exists in SANDBOX_SCHEMA under its expected key + category', () => {
    const missing = fixtureEntries.filter(([, f]) => !findSchemaEntry(f)).map(([id]) => id)
    expect(fixtureEntries.length, 'no entries were compared').toBeGreaterThan(0)
    expect(missing, 'settings present in the PZ fixture but missing from SANDBOX_SCHEMA (key+category)').toEqual([])
  })

  it('every fixtured setting\'s option value->EN-label pairs match SANDBOX_SCHEMA IN ORDER', () => {
    let compared = 0
    const mismatches: Array<{ id: string; ours: string[]; pz: string[] }> = []
    for (const [id, f] of fixtureEntries) {
      const setting = findSchemaEntry(f)
      if (!setting || !setting.options) continue
      compared++
      const ourPairs = setting.options.map((o) => `${o.value}=${o.label}`)
      const pzPairs = f.options.map((o) => `${o.value}=${o.en}`)
      if (JSON.stringify(ourPairs) !== JSON.stringify(pzPairs)) {
        mismatches.push({ id, ours: ourPairs, pz: pzPairs })
      }
    }
    expect(compared, 'no settings had comparable options -- this assertion would otherwise pass vacuously').toBeGreaterThan(0)
    expect(
      mismatches,
      'schema option value/label pairs disagree with PZ (order-sensitive: catches undercounts, wrong labels, AND inversions/reorderings)',
    ).toEqual([])
  })

  it('every fixtured setting\'s default matches PZ\'s Apocalypse.lua default', () => {
    let compared = 0
    const mismatches: Array<{ id: string; ours: unknown; pz: unknown }> = []
    for (const [id, f] of fixtureEntries) {
      const setting = findSchemaEntry(f)
      if (!setting || f.default === null) continue
      compared++
      const ours = typeof setting.default === 'string' ? Number(setting.default) : setting.default
      if (ours !== f.default) mismatches.push({ id, ours: setting.default, pz: f.default })
    }
    expect(compared, 'no settings had a comparable default -- this assertion would otherwise pass vacuously').toBeGreaterThan(0)
    expect(mismatches, 'schema default disagrees with PZ\'s Apocalypse.lua default value').toEqual([])
  })
})
