#!/usr/bin/env node
// Extracts Project Zomboid's own sandbox ground truth (default values, and
// select-option values/labels in English + every locale PZ itself ships)
// from a local PZ install, and writes:
//   1. client/src/lib/__fixtures__/pzSandboxGroundTruth.json -- the single
//      committed fixture serverConfigSchema.pzGroundTruth.test.ts diffs
//      SANDBOX_SCHEMA against on every test run (the drift gate).
//   2. client/src/locales/<lang>/sandboxPz.json for en/de/es/fr/ht/zh-CN/zh-TW --
//      the setting/option LABELS the panel actually renders, sourced from
//      the exact same resolved data as the fixture above. One extractor,
//      one resolved mapping, two outputs -- not two independent parsers
//      that can silently drift apart from each other.
//
// Run manually: `node client/scripts/extract-pz-sandbox-ground-truth.mjs <path to PZ install>`
// This script is never run in CI. Pass a local install when re-syncing against
// a new PZ build; the fixture records the source build.
//
// READ-ONLY on the PZ install. Never writes anything under it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_ROOT = path.resolve(__dirname, '..')

const PZ_ROOT = process.argv[2]
if (!PZ_ROOT) {
  console.error('PZ install path required')
  process.exit(2)
}
const APOC_PATH = path.join(PZ_ROOT, 'media/lua/shared/Sandbox/Apocalypse.lua')
const TRANSLATE_DIR = path.join(PZ_ROOT, 'media/lua/shared/Translate')
const APP_MANIFEST_PATH = path.resolve(PZ_ROOT, '..', '..', 'appmanifest_108600.acf')

const SCHEMA_PATH = path.join(CLIENT_ROOT, 'src/lib/serverConfigSchema.ts')
const FIXTURE_PATH = path.join(CLIENT_ROOT, 'src/lib/__fixtures__/pzSandboxGroundTruth.json')
const LOCALES_DIR = path.join(CLIENT_ROOT, 'src/locales')

// PZ language dir -> our locale code. 'ht' has no PZ translation at all (not
// among PZ's ~29 shipped languages, consistent with ht having no CLDR data
// either and resolving to en-GB elsewhere in this app) -- it still needs a
// full sandboxPz.json (100% English-backfilled) because this repo's
// localeParity test requires every registered locale to share the exact
// same key set for any namespace that exists in any of them.
const LANG_MAP = { en: 'EN', de: 'DE', es: 'ES', fr: 'FR', 'zh-CN': 'CN', 'zh-TW': 'CH', ht: null }

function loadSandboxJson(pzDir) {
  if (!pzDir) return {}
  const p = path.join(TRANSLATE_DIR, pzDir, 'Sandbox.json')
  if (!fs.existsSync(p)) return {}
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

// ---------- Apocalypse.lua (PZ's own default table) ----------
function parseApocalypse(src) {
  const out = { settings: {}, ZombieLore: {}, ZombieConfig: {}, MultiplierConfig: {}, Map: {}, Basement: {} }
  const sections = new Set(['ZombieLore', 'ZombieConfig', 'MultiplierConfig', 'Map', 'Basement'])
  let section = 'settings'
  for (const line of src.split('\n')) {
    const secOpen = line.match(/^\s*(\w+)\s*=\s*\{\s*$/)
    if (secOpen && sections.has(secOpen[1])) { section = secOpen[1]; continue }
    if (/^\s*\},?\s*$/.test(line) && section !== 'settings') { section = 'settings'; continue }
    const kv = line.match(/^\s*(\w+)\s*=\s*(true|false|-?[\d.]+|"[^"]*")\s*,?\s*$/)
    if (kv && kv[1] !== 'Version') {
      let v = kv[2]
      if (v === 'true') v = true
      else if (v === 'false') v = false
      else if (/^".*"$/.test(v)) v = v.slice(1, -1)
      else v = Number(v)
      out[section][kv[1]] = v
    }
  }
  return out
}

// ---------- serverConfigSchema.ts SANDBOX_SCHEMA ----------
function extractObjects(src) {
  const items = []
  let objStart = -1, depth = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '{') { if (depth === 0) objStart = i; depth++ }
    else if (c === '}') {
      depth--
      if (depth === 0 && objStart !== -1) {
        const body = src.slice(objStart, i + 1)
        if (/\bkey\s*:\s*'/.test(body)) items.push(body)
        objStart = -1
      }
    }
  }
  return items
}

function parseOptions(body) {
  const optIdx = body.indexOf('options')
  if (optIdx === -1) return []
  const bracketStart = body.indexOf('[', optIdx)
  if (bracketStart === -1) return []
  let d = 0, j = bracketStart
  for (; j < body.length; j++) {
    if (body[j] === '[') d++
    else if (body[j] === ']') { d--; if (d === 0) break }
  }
  const optionsText = body.slice(bracketStart + 1, j)
  const out = []
  const optRe = /\{\s*value\s*:\s*([^,]+?)\s*,\s*label\s*:\s*'((?:[^'\\]|\\.)*)'\s*\}/g
  let m
  while ((m = optRe.exec(optionsText))) out.push({ value: m[1].trim(), label: m[2].replace(/\\'/g, "'") })
  return out
}

function parseSchemaEntry(body) {
  const keyM = body.match(/\bkey\s*:\s*'([^']*)'/)
  const catM = body.match(/\bcategory\s*:\s*'([^']*)'/)
  const sectionM = body.match(/\bsection\s*:\s*'([^']*)'/)
  const labelM = body.match(/\blabel\s*:\s*'((?:[^'\\]|\\.)*)'/)
  const typeM = body.match(/\btype\s*:\s*'([^']*)'/)
  const defaultM = body.match(/\bdefault\s*:\s*([^,\n]+)/)
  return {
    key: keyM ? keyM[1] : null,
    category: catM ? catM[1] : null,
    section: sectionM ? sectionM[1] : 'settings',
    label: labelM ? labelM[1].replace(/\\'/g, "'") : null,
    type: typeM ? typeM[1] : null,
    default: defaultM ? defaultM[1].trim() : null,
    options: parseOptions(body),
  }
}

function normLabel(s) {
  return String(s).toLowerCase().replace(/%%/g, '%').replace(/\s*-\s*/g, '-').replace(/[.,()]/g, '').replace(/\s+/g, ' ').trim()
}

function buildOptionGroups(json) {
  const groups = new Map()
  const re = /^Sandbox_(.+)_option(\d+)$/
  for (const [k, v] of Object.entries(json)) {
    const m = k.match(re)
    if (m) {
      const prefix = m[1], n = parseInt(m[2], 10)
      if (!groups.has(prefix)) groups.set(prefix, new Map())
      groups.get(prefix).set(n, v)
    }
  }
  return groups
}

function resolveOptionsPrefix(key, options, enGroups) {
  const tries = [key, key + 'Freq', key + 'Chance', key + 'Frequency', key + 'Rate']
  for (const t of tries) if (enGroups.has(t)) return t
  const stripped = key.replace(/(Frequency|Chance|Rate|Freq)$/, '')
  if (stripped !== key) {
    for (const t of [stripped, stripped + 'Freq', stripped + 'Chance', stripped + 'Frequency'])
      if (enGroups.has(t)) return t
  }
  const lower = key.toLowerCase()
  for (const prefix of enGroups.keys())
    if (prefix.toLowerCase() === lower || prefix.toLowerCase() === lower + 'freq') return prefix
  // content fallback: near-exact normalized label-sequence match only
  const schemaNorm = options.map((o) => normLabel(o.label))
  let best = null
  for (const [prefix, m] of enGroups) {
    const maxN = Math.max(...m.keys())
    const labels = []
    for (let i = 1; i <= maxN; i++) labels.push(normLabel(m.get(i) ?? ''))
    let matchLen = 0
    const n = Math.min(labels.length, schemaNorm.length)
    for (let i = 0; i < n; i++) if (labels[i] === schemaNorm[i]) matchLen++
    const score = matchLen / Math.max(labels.length, schemaNorm.length)
    if (!best || score > best.score) best = { prefix, score }
  }
  return best && best.score >= 0.99 ? best.prefix : null
}

function main() {
  if (!fs.existsSync(APOC_PATH)) {
    console.error(`Apocalypse.lua not found at ${APOC_PATH} -- pass the PZ install root as an argument.`)
    process.exit(1)
  }

  const apoc = parseApocalypse(fs.readFileSync(APOC_PATH, 'utf8'))
  const schemaSrc = fs.readFileSync(SCHEMA_PATH, 'utf8')
  const sandboxSrc = schemaSrc.slice(schemaSrc.indexOf('export const SANDBOX_SCHEMA'))
  const entries = extractObjects(sandboxSrc).map(parseSchemaEntry).filter((e) => e.key)

  const enJson = loadSandboxJson('EN')
  const enGroups = buildOptionGroups(enJson)

  const resolved = entries.map((e) => {
    let optionsPrefix = null
    if (e.type === 'select' && e.options.length > 0) {
      optionsPrefix = resolveOptionsPrefix(e.key, e.options, enGroups)
    }
    let baseLabelKey = null
    if (enJson[`Sandbox_${e.key}`] !== undefined) baseLabelKey = e.key
    else if (optionsPrefix && enJson[`Sandbox_${optionsPrefix}`] !== undefined) baseLabelKey = optionsPrefix
    return { ...e, baseLabelKey, optionsPrefix }
  })

  // ---------- Fixture: SELECT-type entries with a resolved PZ options group ----------
  // Scope matches this gate's actual job (option value/label drift, the
  // PlantResilience-class bug) -- defaults for ALL 269 entries were already
  // verified against Apocalypse.lua once (see the enum-audit report); this
  // fixture re-asserts default + option data together, per select setting,
  // going forward.
  // Known-untrustworthy PZ references: the match resolves cleanly (by name
  // or content) but PZ's OWN Sandbox.json entry is the one that's wrong,
  // not our schema. Excluding these here means the drift gate compares
  // against PZ where PZ is trustworthy, instead of failing forever (or
  // worse, "fixing" correct code to match a stale reference). Each entry
  // must carry the evidence, not just an ID -- this list is deliberately
  // hard to add to by accident.
  const KNOWN_STALE_PZ_REFERENCES = {
    'animals.AnimalAgeModifier':
      "PZ's own Sandbox_AnimalAgeModifier_option* has only 3 entries (Very Fast/Fast/Normal). Every sibling " +
      'Animal*Modifier setting (AnimalStatsModifier, AnimalMetaStatsModifier, AnimalPregnancyTime, ' +
      'AnimalMilkIncModifier, AnimalWoolIncModifier, AnimalEggHatch) correctly matches the fuller 6-item ' +
      "AnimalSpeed-family scale (Ultra Fast..Very Slow) content-for-content, and AnimalAgeModifier's own " +
      'description ("Speed at which animals age") fits that same family -- PZ\'s reference here looks stale/' +
      'vestigial, not our schema. Confirmed with the operator during the 2026-08-26 enum audit; filed for a ' +
      'live-game check, not asserted as fact.',
  }

  const settings = {}
  let skipped = []
  for (const e of resolved) {
    if (e.type !== 'select' || e.options.length === 0) continue
    if (!e.optionsPrefix) { skipped.push(`${e.category}.${e.key}`); continue }
    if (`${e.category}.${e.key}` in KNOWN_STALE_PZ_REFERENCES) continue
    const group = enGroups.get(e.optionsPrefix)
    const maxN = Math.max(...group.keys())
    const perLangJson = {}
    for (const [localeCode, pzDir] of Object.entries(LANG_MAP)) {
      if (localeCode === 'en') continue
      perLangJson[localeCode] = loadSandboxJson(pzDir)
    }
    const options = []
    for (let n = 1; n <= maxN; n++) {
      const row = { value: n, en: group.get(n) ?? null }
      for (const localeCode of Object.keys(LANG_MAP)) {
        if (localeCode === 'en') continue
        const json = perLangJson[localeCode]
        const v = json[`Sandbox_${e.optionsPrefix}_option${n}`]
        row[localeCode] = typeof v === 'string' && v.trim() !== '' ? v : null
      }
      options.push(row)
    }
    const apocSection = apoc[e.section] || apoc.settings
    settings[`${e.category}.${e.key}`] = {
      key: e.key,
      category: e.category,
      section: e.section,
      default: apocSection[e.key] ?? null,
      options,
    }
  }

  let buildId = null
  try {
    const manifest = fs.readFileSync(APP_MANIFEST_PATH, 'utf8')
    buildId = manifest.match(/"buildid"\s*"(\d+)"/)?.[1] ?? null
  } catch { /* manifest not found -- leave buildId null, don't fail extraction over it */ }

  const fixture = {
    _provenance: {
      pzAppId: '108600',
      pzBuildId: buildId,
      extractedAt: new Date().toISOString().slice(0, 10),
      sources: {
        defaults: 'media/lua/shared/Sandbox/Apocalypse.lua',
        optionLabelsEn: 'media/lua/shared/Translate/EN/Sandbox.json',
        optionLabelsDe: 'media/lua/shared/Translate/DE/Sandbox.json',
        optionLabelsEs: 'media/lua/shared/Translate/ES/Sandbox.json',
        optionLabelsFr: 'media/lua/shared/Translate/FR/Sandbox.json',
        optionLabelsZhCN: 'media/lua/shared/Translate/CN/Sandbox.json',
        optionLabelsZhTW: 'media/lua/shared/Translate/CH/Sandbox.json',
      },
      note:
        'Paths are relative to the PZ Steam install root. ht has no PZ translation and carries no per-language entry here. ' +
        'Scope: only SANDBOX_SCHEMA select-type entries with a resolved, trustworthy PZ option-group match. ' +
        `${skipped.length} select-type entries had no resolvable PZ option group and are intentionally excluded: ${skipped.join(', ') || '(none)'}. ` +
        `${Object.keys(KNOWN_STALE_PZ_REFERENCES).length} more resolved but PZ's own reference is known-stale and intentionally excluded ` +
        `(see knownStalePzReferences below for each one's evidence): ${Object.keys(KNOWN_STALE_PZ_REFERENCES).join(', ') || '(none)'}.`,
      knownStalePzReferences: KNOWN_STALE_PZ_REFERENCES,
      settingCount: Object.keys(settings).length,
    },
    settings,
  }

  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true })
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n', 'utf8')
  console.log(`Wrote fixture: ${FIXTURE_PATH} (${fixture._provenance.settingCount} settings)`)

  // ---------- Locale files: full key skeleton for every registered locale ----------
  // Every SANDBOX_SCHEMA entry (not just the select-type/fixture-scoped ones)
  // gets a label; select-type entries also get option labels. en's file is
  // the full skeleton (its own values, mechanically equal to the schema's
  // inline fallback) and every other locale matches its key set exactly
  // (localeParity requirement), using PZ's own translation where available
  // and the same schema-derived English text as an explicit value everywhere
  // PZ has no translation for that key (ht: everywhere, always).
  const coverage = {}
  for (const [localeCode, pzDir] of Object.entries(LANG_MAP)) {
    const json = localeCode === 'en' ? enJson : loadSandboxJson(pzDir)
    const out = {}
    let labelHit = 0, labelTotal = 0, optionHit = 0, optionTotal = 0

    for (const e of resolved) {
      labelTotal++
      let labelText = e.label
      if (localeCode === 'en') labelHit++
      else if (e.baseLabelKey) {
        const v = json[`Sandbox_${e.baseLabelKey}`]
        if (typeof v === 'string' && v.trim() !== '') { labelText = v; labelHit++ }
      }

      let optionsOut = null
      if (e.type === 'select' && e.options.length > 0) {
        optionsOut = {}
        for (const opt of e.options) {
          optionTotal++
          let optText = opt.label
          if (localeCode === 'en') optionHit++
          else if (e.optionsPrefix) {
            const v = json[`Sandbox_${e.optionsPrefix}_option${Number(opt.value)}`]
            if (typeof v === 'string' && v.trim() !== '') { optText = v; optionHit++ }
          }
          optionsOut[opt.value] = { label: optText }
        }
      }

      out[e.category] ??= {}
      out[e.category][e.key] = { label: labelText }
      if (optionsOut) out[e.category][e.key].options = optionsOut
    }

    const outPath = path.join(LOCALES_DIR, localeCode, 'sandboxPz.json')
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8')
    coverage[localeCode] = {
      labels: `${labelHit}/${labelTotal}`,
      options: `${optionHit}/${optionTotal}`,
    }
  }

  console.log('\nReal PZ translation coverage (files are always 100% key-complete; this is how much is an actual PZ translation vs. an English backfill):')
  for (const [lang, c] of Object.entries(coverage)) console.log(`  ${lang}: labels ${c.labels}, options ${c.options}`)
}

main()
