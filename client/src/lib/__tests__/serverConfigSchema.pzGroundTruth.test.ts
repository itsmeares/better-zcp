import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SANDBOX_SCHEMA } from '../serverConfigSchema'

// The drift gate: catches serverConfigSchema.ts's SANDBOX_SCHEMA silently
// disagreeing with Project Zomboid's own ground truth (option values,
// option labels, and defaults -- see the fixture's own _provenance.note for
// the exact split of what PZ owns vs. what this panel owns). The 18-error
// audit that found the PlantResilience inversion and the MetaEvent
// undercount was a one-time comparison by a careful person; this is the
// same comparison run every test invocation, forever, against a COMMITTED
// fixture rather than a live PZ install (so CI needs no PZ install at all).
//
// Regenerate the fixture with:
// node client/scripts/extract-pz-sandbox-ground-truth.mjs <path-to-pz-install>
//
// THIS TEST MUST NEVER PASS VACUOUSLY. A fixture that's missing, empty,
// unparseable, or that matches zero schema entries is a broken gate, not a
// clean sweep -- every comparison below independently asserts it actually
// examined a nonzero, known count, not just that no mismatches were found
// (an empty mismatch list from zero comparisons would otherwise pass this
// test while checking nothing at all).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.resolve(__dirname, '../__fixtures__/pzSandboxGroundTruth.json')

// The known, resolved denominator: 80 SANDBOX_SCHEMA select-type entries
// have a trustworthy PZ option group the extractor could confidently
// resolve. 2 more (PlayerSpawnZombieRemoval, SpawnFrequency) are
// known-unresolved, and 1 more (AnimalAgeModifier) resolved but PZ's own
// reference is known-stale -- all 3 intentionally excluded; see the
// fixture's _provenance.note and knownStalePzReferences for why. If this
// number changes, something changed the join or the schema's select-type
// entries -- investigate before updating it, don't just bump it to match.
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
    // Order-sensitive on purpose: a value/label INVERSION (PlantResilience's
    // actual bug) has the right count and the right label SET, so a
    // comparison that only checks count or membership would pass a mirror
    // image happily. Comparing "value=label" pairs positionally is what
    // catches that shape, not just an undercount.
    let compared = 0
    const mismatches: Array<{ id: string; ours: string[]; pz: string[] }> = []
    for (const [id, f] of fixtureEntries) {
      const setting = findSchemaEntry(f)
      if (!setting || !setting.options) continue // already reported by the previous test
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
