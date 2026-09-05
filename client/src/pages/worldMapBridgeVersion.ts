// getServerInfo only started sending isAlive/isInfected/accessLevel per
// player at PanelBridge v1.7.39 (see that version's compatibility note in
// PanelBridge.lua). Before that, the keys are absent from the response
// entirely, not merely falsy -- a client that assumes them present (or
// defaults them, e.g. `isAlive ?? true`) renders every player as alive,
// uninfected and non-admin regardless of their real state, which is
// confidently wrong rather than visibly missing. Gating on the bridge's
// own self-reported version, rather than inferring support from whether
// the keys happen to be present, keeps that decision in one explicit place
// instead of scattered `!== undefined` inference at each call site.
//
// Scoped narrowly to these three fields on purpose -- this is not a general
// capability-negotiation utility. If other panelBridge fields ever need the
// same treatment, extend deliberately rather than reusing this blindly.
const MIN_PLAYER_STATUS_BRIDGE_VERSION: readonly [number, number, number] = [1, 7, 39];

function parseBridgeVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// TOTAL: an unparseable, missing, or empty version returns false ("too
// old"), never true. Failing open here -- assuming an unrecognised string
// is new enough -- would recreate the exact defect this gate exists to
// close, just moved one layer up.
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
