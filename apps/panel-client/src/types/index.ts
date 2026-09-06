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
  aWins?: number
  bWins?: number
  thirdPartyWins?: number
  unknownWins?: number
}

export interface ConflictModRef {
  workshopId: string
  modId: string
  modName: string
}

export interface ConflictOverlap {
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
  modId: string
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

export interface ScanStreamModScanned {
  modId: string
  modName: string
  workshopId: string
  fileCount: number
  modsScanned: number
  totalWorkshopIds: number
  progress: number
}

export interface ScanStreamConflictFound {
  file: string
  severity: 'high' | 'medium' | 'low'
  categoryLabel: string
  mods: string[]
  conflictsSoFar: number
}
