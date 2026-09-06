import { describe, it, expect } from 'vitest'
import { getBridgeOperationTemplates } from '../Events'
import en from '../../locales/en/events.json'

// bug-hunt-2026-08-26, follow-up to the moderationBanUser IP-parity fix
// (196e057): god asked the same question of every bridgeOperationTemplates
// entry that surfaced the ban one -- Events.tsx renders each operation's
// description verbatim as the visible subtitle under the operation picker
// (~line 2760), so a wrong description reaches the operator with nothing
// else in the UI to correct it.
//
// Audited denominator first, since it changed the shape of the task: the
// locale namespace has 19 keys under `operations`, but only 17 are ever
// rendered -- `createFaction` and `removeFaction` are orphaned translations
// left behind when an earlier fix (see Events.bridgeFactionOperations.test.ts)
// removed those two from the templates/forms/groups because the underlying
// Faction.createFaction/removeFaction methods don't exist in the real B42
// jar. They cost nothing (never shown to an operator) but are dead weight;
// noted for god, not deleted here since cleaning them up wasn't what was
// asked and they're inert.
//
// All 17 rendered descriptions make a CHECKABLE claim -- none are vague
// filler ("does something with X") -- which is itself a real result: this
// catalog is small and uniformly specific, unlike the mixed vague/checkable
// split Pam found across permissions.js's ~100 capability descriptions.
// Checked every one against its PanelBridge.lua handler:
//   getSafehouses            -- "get all safehouses and metadata": matches
//                                (id/title/owner/x/y/w/h/players/etc, all
//                                safehouses in SafeHouse.getSafehouseList())
//   safehouseAddPlayer       -- matches (sh:addPlayer, verified via getPlayers)
//   safehouseRemovePlayer    -- matches (sh:removePlayer, verified likewise)
//   safehouseSetOwner        -- "transfer ownership": matches (sh:setOwner
//                                replaces the single owner field, verified
//                                via getOwner())
//   safehouseSetRespawn      -- matches (sh:setRespawnInSafehouse, verified
//                                via isRespawnInSafehouse)
//   getFactions              -- matches (name/owner/tag/players/playerCount,
//                                all factions in Faction.getFactions())
//   factionAddPlayer         -- matches (faction:addPlayer, verified via
//                                isMember)
//   factionRemovePlayer      -- matches (faction:removePlayer, verified
//                                likewise)
//   factionSetTag            -- "short tag": matches (normalizeMessage caps
//                                the tag at 8 chars, verified via getTag())
//   getVehiclesDetailed      -- "loaded vehicles with telemetry": matches
//                                (getVehiclesList() is the currently-loaded
//                                set, not all vehicles ever spawned; fields
//                                include speed/battery/fuel/alarm/siren)
//   triggerSwarmEvent        -- "rectangular area": matches (x1/y1/x2/y2)
//   runEventSequence         -- names exactly 5 step kinds (chat/weather/
//                                swarm/utilities/noise): the handler's kind
//                                dispatch supports precisely those 5, no
//                                more, no fewer -- exact match
//   getInfrastructureSnapshot -- "hydro/weather state + optional sample
//                                point": matches (hydroPowerOn/weather/
//                                globalTemperature, plus an x/y/z sample
//                                when provided)
//   moderationKickUser       -- "via BanSystem": matches (BanSystem.KickUser)
//   moderationBanUser        -- corrected in 196e057, the finding that
//                                triggered this whole audit
//   moderationBanIP          -- matches (BanSystem.BanIP)
//   moderationBanSteamID     -- matches (BanSystem's SteamID ban path)
//
// Result: no new mismatch found. moderationBanUser (already fixed) was the
// only one. This test pins the two structural facts that make that result
// worth something next month: the templates/locale denominator relationship,
// and that no future addition can silently ship without a description.

const t = ((key: string) => key) as Parameters<typeof getBridgeOperationTemplates>[0]

describe('Events -- bridge operation description audit (2026-08-27)', () => {
  it('every rendered bridge operation has a non-empty description -- none can ship silently blank', () => {
    const templates = getBridgeOperationTemplates(t)
    for (const [key, meta] of Object.entries(templates)) {
      expect(meta.description, `${key} has no description`).toBeTruthy()
      expect(meta.description.trim().length, `${key}'s description is blank`).toBeGreaterThan(0)
    }
  })

  it('does not render the two orphaned faction locale entries -- confirms they stay dead, not just currently unused', () => {
    const templates = getBridgeOperationTemplates(t)
    expect(Object.keys(templates)).not.toContain('createFaction')
    expect(Object.keys(templates)).not.toContain('removeFaction')
    // The orphaned keys still exist in the locale file itself (harmless,
    // never read) -- this is what "orphaned" means here, not "removed".
    expect(en.operations).toHaveProperty('createFaction')
    expect(en.operations).toHaveProperty('removeFaction')
  })
})
