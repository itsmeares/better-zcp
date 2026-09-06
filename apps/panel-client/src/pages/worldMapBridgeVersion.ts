const MIN_PLAYER_STATUS_BRIDGE_VERSION: readonly [number, number, number] = [1, 7, 39];

function parseBridgeVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function bridgeSupportsPlayerStatus(version: string | null | undefined): boolean {
  if (!version) return false;
  const actual = parseBridgeVersion(version);
  if (!actual) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== MIN_PLAYER_STATUS_BRIDGE_VERSION[i]) {
      return actual[i] > MIN_PLAYER_STATUS_BRIDGE_VERSION[i];
    }
  }
  return true;
}
