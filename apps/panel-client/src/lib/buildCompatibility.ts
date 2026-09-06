export type BuildMetadata = {
  panelVersion: string
  buildSha: string
  apiContractVersion: number
}

export type BackendBuildMetadata = Partial<BuildMetadata> & {
  version?: string
}

const UNKNOWN_VALUES = new Set(['', 'unknown', '0.0.0'])

function knownValue(value: unknown): string {
  const normalized = String(value ?? '').trim()
  return UNKNOWN_VALUES.has(normalized.toLowerCase()) ? '' : normalized
}

export function compiledBuildMetadata(): BuildMetadata {
  return {
    panelVersion: typeof __PANEL_VERSION__ !== 'undefined' ? __PANEL_VERSION__ : '0.0.0',
    buildSha: typeof __PANEL_BUILD_SHA__ !== 'undefined' ? __PANEL_BUILD_SHA__ : 'unknown',
    apiContractVersion:
      typeof __PANEL_API_CONTRACT_VERSION__ !== 'undefined'
        ? __PANEL_API_CONTRACT_VERSION__
        : 1,
  }
}

export function assessBuildCompatibility(
  frontend: BuildMetadata,
  backend: BackendBuildMetadata,
) {
  const frontendVersion = knownValue(frontend.panelVersion)
  const backendVersion = knownValue(backend.panelVersion) || knownValue(backend.version)
  const frontendSha = knownValue(frontend.buildSha)
  const backendSha = knownValue(backend.buildSha)
  const frontendContract = Number(frontend.apiContractVersion)
  const backendContract = Number(backend.apiContractVersion)
  const compatible =
    !frontendVersion || !backendVersion || frontendVersion === backendVersion
    && (!frontendSha || !backendSha || frontendSha === backendSha)
    && (!Number.isInteger(frontendContract) || !Number.isInteger(backendContract) || frontendContract === backendContract)
  return compatible
    ? { compatible: true as const }
    : {
        compatible: false as const,
        code: 'version_mismatch' as const,
        reason: 'The frontend and backend were built from different panel versions.',
      }
}
