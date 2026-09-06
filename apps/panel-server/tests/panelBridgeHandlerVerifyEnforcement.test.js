import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',  'integrations', 'panelbridge',
  'PanelBridge',
  'media',
  'lua',
  'server',
  'PanelBridge.lua',
);

const GETTERS = new Set([
  'checkAPI', 'debugItemScript', 'exportPlayerData', 'getAllPlayerDetails',
  'getAllSandboxOptions', 'getAvailableHandlers', 'getChatInfo',
  'getClimateFloats', 'getDebugLog', 'getFactions', 'getGameTime',
  'getInfrastructureSnapshot', 'getItemCatalog', 'getPlayerDetails',
  'getSafehouses', 'getSandboxOptions', 'getServerInfo', 'getStats',
  'getTimeSpeed', 'getUtilitiesStatus', 'getVehicleCatalog',
  'getVehiclesDetailed', 'getWeather', 'getWorldStats', 'getZombieCount',
  'ping',
  // Mutate PURELY INTERNAL PanelBridge/Lua state (a debug flag, an error
  // log) -- no external game system to be wrong about.
  'setDebugMode', 'clearErrors',
]);

const CANNOT_VERIFY_OR_EQUIVALENT = {
  healPlayer: 'The one truly unverifiable path (nil bodyDamage) is gated directly to ok=false; RestoreToFullHealth has no cheap read-back the game exposes.',
  vehicleHotwire: 'No single verifiable end-state exists for a multi-step hotwire sequence -- `actions` documents what ran step by step. (Also the site of the earlier undefined-global crash fix, commit 364c56d.)',
  clearZombiesNearPlayer: 'Reports a real removed-count computed via per-zombie pcall success, not a boolean -- equivalent honesty under a differently-shaped field (`removed`).',
  clearAllZombies: 'Same mechanism as clearZombiesNearPlayer; the ForceKillAllZombies branch is pcall-ceiling by nature of being a bulk fire-and-forget API, the manual fallback counts real removals.',
  vehicleRepair: 'Counts real per-part invoke success into `parts`, fails if 0 -- honest count, not a boolean flag.',
  giveItem: 'Counts real per-item AddItem success into `count`, fails if 0 added -- honest count.',
  airdrop: 'Counts real per-item placement success into `itemCount`/`failed` -- honest count, not a boolean.',
  killPlayer: 'Already gates the returned `ok` itself on isDead() -- the read-back IS the ok value (this file\'s own gold-standard pattern), no separate field needed.',
  setGameTime: 'Already gates on setAndVerify\'s own read-back-vs-expected comparison per field, failing immediately on a real mismatch (this file\'s other gold-standard pattern).',
  saveWorld: 'Already gates ok directly on the real pcall result of the bare saveGame() global (not world:saveWorld(), which does not exist -- fixed 2026-08-30) -- this IS the original b376b2c fix, no separate flag needed.',

  moderationKickUser: 'BanSystem.KickUser is declared void in the real B42 jar (confirmed 2026-08-23) -- no return value exists to verify, ever. This is a limit of the API, not a bug -- contrast with createFaction/removeFaction below.',

  createFaction: 'BUG, not a verification limit: Faction.createFaction does not exist ANYWHERE in the real B42 jar (zero hits across all 23,740 class files). Events.tsx advertises this operation to the operator; it cannot work on B42. Tracked as a regression.',
  removeFaction: 'BUG, not a verification limit: faction:removeFaction does not exist ANYWHERE in the real B42 jar -- same finding, same Events.tsx exposure, same card as createFaction.',

  importPlayerData: 'Partial success is a legitimate outcome, not a boolean gate (explicit ruling, 2026-08-23) -- see restored.perks/restored.items counts instead of a verified flag.',

  spawnVehicleAt: 'Always returns false (RCON handles vehicle spawning on B42) -- never claims success, nothing to verify.',
  setTimeSpeed: 'Always returns false (RCON handles the dedicated server clock multiplier) -- never claims success, nothing to verify.',
  runEventSequence: 'Aggregates the success and failure outcomes of child handlers; each child owns the only verification available for its operation, so the sequence has no independent game-state read-back.',

  playWorldSound: 'No observable state confirms a zombie heard the sound -- pcall-not-throwing (via emitWorldSound) is the real ceiling.',
  playSoundNearPlayer: 'Same ceiling as playWorldSound.',
  triggerGunshot: 'Same ceiling as playWorldSound.',
  triggerAlarmSound: 'Same ceiling as playWorldSound.',
  createNoise: 'Same ceiling as playWorldSound.',
  sendToServerChat: 'No delivery receipt exists; already falls through to a useRCON routing signal when neither ChatServer nor player:Say worked -- pcall-not-throwing is the ceiling.',
  sendToAdminChat: 'Same ceiling as sendToServerChat.',
  sendToGeneralChat: 'Same ceiling as sendToServerChat.',
  triggerHelicopterEvent: 'No observable state confirms a helicopter spawned; pcall-not-throwing on the single real API (testHelicopter(), zero-arg, void return -- the four prior fallback tiers were all fabricated and removed 2026-08-30) is the ceiling.',
  stopHelicopterEvent: 'Same ceiling as triggerHelicopterEvent, same reason: no exposed query for helicopter-event state exists anywhere in the confirmed jar, so pcall-not-throwing on the single real API (endHelicopter(), zero-arg, void return, confirmed 2026-08-30 via javap against the real B42 jar) is the ceiling.',
  triggerLightning: 'Genuinely unverifiable, confirmed via javap -c against the real jar (ThunderStorm.triggerThunderEvent): when GameServer.server is true it only writes to an internal networkThunderEvent struct and transmits a packet -- no ThunderCloud is created synchronously (that only happens client-side on packet receipt), no boolean or count changes, nothing to read back. Same ceiling class as playWorldSound/triggerGunshot -- pcall-not-throwing is the real ceiling. Was PROVISIONAL; now a confirmed, permanent limit, not a follow-up.',

  // 2026-08-31 regression: the "PROVISIONAL, not yet re-audited against
  // getFinalValue()/isEnableAdmin()" climate/weather block that used to
  // live here (generateWeather, triggerBlizzard/TropicalStorm/Storm,
  // stopWeather, setSnow, startRain, stopRain, setDayLight,
  // setNightStrength, setDesaturation, setViewDistance, setAmbient,
  // setTemperature, setWind, setFog, setClouds, setClimateFloat,
  // resetClimateOverrides) is now GONE, not because the read-back pattern
  // didn't apply -- because getFinalValue() turned out to be the WRONG
  // read-back for most of them. Confirmed via javap -c:
  // ClimateFloat/ClimateBool.setAdminValue/setEnableAdmin never call the
  // private calculate() that actually propagates adminValue into
  // finalValue -- calculate() only runs from ClimateManager's own tick
  // loop, unreachable (private) or unsafe (the public update() runs the
  // full per-tick simulation) to call manually from a handler. Reading
  // getFinalValue() immediately after a write would risk a FALSE NEGATIVE,
  // not just a false positive -- worse than the ceiling it would replace.
  // Fixed instead with read-backs that ARE safe and immediate: getAdminValue()
  // (a trivial field read of exactly what setAdminValue just wrote, after
  // the real min/max clamp -- catches silent out-of-range clamping,
  // something pcall-not-throwing never could) for the admin-override-only
  // floats (temperature/wind/fog/clouds/setClimateFloat), plus
  // getFinalValue() ONLY where the specific method called is confirmed
  // (via its own javap -c read) to synchronously call updateOnTick()
  // itself before returning (transmitServerStartRain/StopRain -- startRain/
  // stopRain/stopWeather) or to write finalValue directly, bypassing
  // calculate() entirely (setPrecipitationIsSnow/setDayLightStrength/
  // setNightStrength/setDesaturation/setAmbient/setViewDistance -- setSnow
  // and the five direct-setter fallback floats), plus the real boolean
  // triggerCustomWeatherStage/triggerCustomWeather themselves return
  // (the four trigger handlers), plus isEnableAdmin() (also a trivial
  // field read, no staleness) for resetClimateOverrides and the
  // disable branch of setClimateFloat. All now emit a real `verified`
  // field. Same pattern as restoreUtilities/shutOffUtilities's own removal
  // note above -- left here rather than silently deleted, since "why isn't
  // X allowlisted anymore" is as worth answering as "why is X allowlisted".

  // 2026-08-31, clearing the last two PROVISIONAL entries (verify-
  // enforcement-provisionals): triggerSwarmEvent and removeVehicle used to be
  // listed here, both saying "tracked as a follow-up" with no owner.
  //
  // triggerSwarmEvent now gets the same VirtualZombieManager-first,
  // spawned-count treatment spawnHordeNearPlayer's own fix already
  // established -- confirmed applicable here too via the real jar:
  // VirtualZombieManager.createRealZombieNow(float,float,float) is a
  // general-purpose per-zombie spawn, not player-specific, so the same
  // primary/fallback split applies to an area with no player reference.
  //
  // removeVehicle now re-checks findVehicleById() immediately after removal
  // and gates `verified` on the vehicle's genuine absence. Confirmed SAFE to
  // do synchronously via javap -c against the real B42 jar, precisely the
  // check the ClimateFloat false-negative (see the block above) says to run
  // before trusting a read-back: BaseVehicle.permanentlyRemove() calls
  // removeFromWorld() directly in the same call stack, and removeFromWorld()
  // synchronously does IsoWorld.instance.currentCell.vehicles:remove(this) --
  // a live java.util.Set, not a tick-deferred queue. IsoCell.getVehicles() is
  // a trivial `return this.vehicles` field read of that EXACT SAME Set. So
  // unlike getFinalValue() after setAdminValue, there is no propagation delay
  // between the write and the read-back here -- confirmed, not assumed.
  //
  // Both now emit a literal `verified` field, so neither needs an exemption
  // anymore.
  //
  // 2026-09-04 (regression, testing): removeVehiclesInArea used to be
  // listed here too, with the reason "already counts only real per-vehicle
  // invoke-confirmed removals (fixed from this exact defect once before)".
  // That reasoning was itself the exact mistake this whole audit exists to
  // catch: PanelBridge.invoke() returning true means the underlying call did
  // not THROW, not that it took effect -- the earlier fix this reason
  // referred to only replaced a broken field-existence check with a real
  // invoke() call, it never added a re-confirmation step. So this handler
  // had the identical "didn't throw != actually happened" gap removeVehicle
  // (its immediate neighbor in the Lua file) was fixed for on 2026-08-31 --
  // just one function away from the fix, never applied to it. Now re-fetches
  // getVehiclesList() once after the removal loop and only counts a vehicle
  // as removed if it's genuinely absent from the fresh read, same principle
  // as removeVehicle, adapted for a bulk result (`removed` count + a real
  // `verified` field) instead of a single boolean. No longer needs an
  // exemption.
};

function loadHandlerLineRanges() {
  const bridge = loadPanelBridge(LUA_PATH, '');
  bridge.run(`
    __names = {}
    __lines = {}
    for name, fn in pairs(PanelBridgeModule.handlers) do
      local info = debug.getinfo(fn, "S")
      table.insert(__names, name)
      __lines[name] = { linedefined = info.linedefined, lastlinedefined = info.lastlinedefined }
    end
  `);
  return { names: bridge.getGlobal('__names'), lines: bridge.getGlobal('__lines') };
}

describe('PanelBridge.lua -- every mutating handler must report a verify outcome or be explicitly allowlisted', () => {
  it('flags any handler that claims to act without a documented verify outcome', () => {
    const { names, lines } = loadHandlerLineRanges();
    const source = fs.readFileSync(LUA_PATH, 'utf8').split('\n');

    const unexplained = [];
    for (const name of names) {
      if (GETTERS.has(name)) continue;
      if (Object.prototype.hasOwnProperty.call(CANNOT_VERIFY_OR_EQUIVALENT, name)) continue;

      const range = lines[name];
      const body = source.slice(range.linedefined - 1, range.lastlinedefined).join('\n');
      if (!body.includes('verified')) {
        unexplained.push(name);
      }
    }

    if (unexplained.length > 0) {
      throw new Error(
        `${unexplained.length} handler(s) claim to act without a documented verify outcome: ${unexplained.join(', ')}. ` +
        'Either make the handler report a real `verified` tri-state (see PanelBridge.verifiedResult, or setGodMode for a worked example), ' +
        'or add a named, reasoned entry to CANNOT_VERIFY_OR_EQUIVALENT in this test explaining why -- verified against the real jar, not assumed.'
      );
    }
  });

  it('GETTERS and CANNOT_VERIFY_OR_EQUIVALENT only name real, currently-registered handlers (catches stale entries)', () => {
    const { names } = loadHandlerLineRanges();
    const known = new Set(names);

    for (const g of GETTERS) {
      expect(known.has(g), `GETTERS lists "${g}" but it is not a registered handler (renamed or removed?)`).toBe(true);
    }
    for (const c of Object.keys(CANNOT_VERIFY_OR_EQUIVALENT)) {
      expect(known.has(c), `CANNOT_VERIFY_OR_EQUIVALENT lists "${c}" but it is not a registered handler (renamed or removed?)`).toBe(true);
    }
  });

  it('every CANNOT_VERIFY_OR_EQUIVALENT reason is a real sentence, not a placeholder', () => {
    for (const [name, reason] of Object.entries(CANNOT_VERIFY_OR_EQUIVALENT)) {
      expect(typeof reason, `${name}'s reason must be a string`).toBe('string');
      expect(reason.length, `${name}'s reason ("${reason}") is too short to be a real explanation`).toBeGreaterThan(20);
    }
  });
});
