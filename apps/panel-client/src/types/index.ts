// Mod Conflict Scanner Types
export interface ConflictScanResult {
  totalConflicts: number
  identicalSkipped: number
  additiveSkipped?: number
  pzAdditiveSkipped?: number
  pzAdditiveBreakdown?: {
    sandbox: number
    scripts: number
    clothing: number
    fileguidtable: number
    translate: number
  }
  pairs: ConflictPair[]
  totalPairs: number
  modsScanned: number
  modsNotFound?: number
  modsSkippedInactive?: number
  totalWorkshopIds?: number
  missingDeps: MissingDependency[]
  steamDeps?: SteamDependency[]
  modLoadOrder: string[]
  truncated?: boolean
  warnings?: string[]
  scanDurationMs?: number
  idCollisions?: ModIdCollision[]
}

export interface ConflictPair {
  modA: ConflictModRef
  modB: ConflictModRef
  files: ConflictFile[]
  highCount: number
  mediumCount: number
  lowCount: number
  /** Per-file load-order winner counts. aWins = files where modA wins. */
  aWins?: number
  bWins?: number
  /** Files where a *third* mod (not modA, not modB) wins because the same file
   *  is also shipped by a later mod in the load order — in that case the pair
   *  itself is irrelevant; the loser of the pair loses anyway. */
  thirdPartyWins?: number
  /** Files whose winner can't be determined (one of the mods is not in Mods=). */
  unknownWins?: number
}

export interface ConflictModRef {
  workshopId: string
  modId: string
  modName: string
}

export interface ConflictOverlap {
  /** What kind of identifiers the items[] are: lua functions/events/classes,
   *  PZ script defs (module.type.name), translation keys, clothing item ids,
   *  or 'lua-shadow' meaning Lua files coexist with no overlapping symbols
   *  (one fully replaces the other but they don't fight for the same names). */
  kind: 'lua-symbols' | 'lua-shadow' | 'script-defs' | 'clothing-items' | 'translation-keys'
  items: string[]
  total: number
}

export interface ConflictFile {
  file: string
  category: string
  categoryLabel?: string
  severity: 'high' | 'medium' | 'low'
  winner?: ConflictModRef | null
  overlap?: ConflictOverlap | null
}

export interface ModIdCollision {
  /** Internal mod id (the Mods= entry) declared by multiple workshop items. */
  modId: string
  /** True when this mod id is in the active Mods= list. */
  active: boolean
  sources: { workshopId: string; modName: string; active: boolean }[]
}

export interface MissingDependency {
  modId: string
  modName: string
  workshopId: string
  missingDep: string
  resolvedWorkshopId?: string
  resolvedModName?: string
}

export interface SteamDependency {
  parentWorkshopId: string
  parentName: string
  childWorkshopId: string
  childName: string
  source: 'steam'
}

// SSE streaming scan event types
export interface ScanStreamModScanned {
  modId: string
  modName: string
  workshopId: string
  fileCount: number
  modsScanned: number
  totalWorkshopIds: number
  progress: number  // 0-60
}

export interface ScanStreamConflictFound {
  file: string
  severity: 'high' | 'medium' | 'low'
  categoryLabel: string
  mods: string[]
  conflictsSoFar: number
}
