#!/usr/bin/env node
// Attempts to classify each RCON command server/services/rcon.js sends as
// INFORMATIVE (the RCON reply carries real content -- a list, a dump) or
// NO_LOOP_EVIDENCE (this script found no positive signal either way -- that
// includes genuine bare-ack commands like save/quit AND any informative
// command that builds its reply without iterating a java.util collection),
// using only what is reliably readable from the class file WITHOUT decoding
// bytecode instructions (see README.md -- that is a materially bigger
// undertaking this script deliberately does not attempt).
//
// Signal used: whether the class's constant pool references
// java.util.Iterator / java.util.List / java.util.ArrayList / java.util.Map
// enumeration methods (hasNext/next/size/get/entrySet/keySet). A tiny,
// single-purpose command class that talks to one of these is very likely
// looping over a collection to build its reply -- every command already
// verified informative commands such as players, showoptions, and stats show
// exactly this pattern.
//
// The collection-reference signal is the only decision input. A raw
// constant-pool string count does not correlate with response shape, so it is
// reported only as context and never drives the verdict.
//
// This is not proof of what the method actually returns. A class could
// reference Iterator for validation logic that never reaches the reply, or
// build a short reply without ever touching a collection. Read it as a
// strong, jar-grounded HINT for the ~44 commands this panel actually calls
// (small, single-purpose classes, so cross-contamination from unrelated
// logic in the same class is unlikely) -- not a certainty, and NOT
// something to invert into an automatic pass/fail detector. See
// README.md and the accompanying report for the full reasoning on why a
// stronger classifier would require full bytecode control-flow decoding.
//
// Usage: node scripts/jar-audit/classify-response-shapes.mjs <path-to-projectzomboid.jar>

import unzipper from "unzipper";
import { parseClass, listMethodRefs } from "./classfile-parser.mjs";

const jarPath = process.argv[2];
if (!jarPath) {
  console.error("Usage: node classify-response-shapes.mjs <path-to-projectzomboid.jar>");
  process.exit(1);
}

// Every command server/services/rcon.js sends, mapped to its real command
// class (from scan-rcon-commands.mjs's output) -- hand-curated, same
// limitation as scan-lua-calls.mjs's receiver map: update by hand if
// rcon.js starts calling something new.
const RCON_COMMAND_CLASSES = {
  save: "SaveCommand",
  quit: "QuitCommand",
  servermsg: "ServerMessageCommand",
  players: "PlayersCommand",
  kickuser: "KickUserCommand",
  banuser: "BanUserCommand",
  unbanuser: "UnbanUserCommand",
  setaccesslevel: "SetAccessLevelCommand",
  adduser: "AddUserCommand",
  removeuserfromwhitelist: "RemoveUserFromWhiteList",
  teleport: "TeleportCommand",
  teleportto: "TeleportToCommand",
  additem: "AddItemCommand",
  addxp: "AddXPCommand",
  addvehicle: "AddVehicleCommand",
  startrain: "StartRainCommand",
  stoprain: "StopRainCommand",
  startstorm: "StartStormCommand",
  stopweather: "StopWeatherCommand",
  chopper: "ChopperCommand",
  gunshot: "GunShotCommand",
  lightning: "LightningCommand",
  thunder: "ThunderCommand",
  createhorde: "CreateHordeCommand",
  godmod: "GodModeCommand",
  godmodplayer: "GodModePlayerCommand",
  invisible: "InvisibleCommand",
  invisibleplayer: "InvisiblePlayerCommand",
  noclip: "NoClipCommand",
  checkModsNeedUpdate: "CheckModsNeedUpdate",
  showoptions: "ShowOptionsCommand",
  reloadoptions: "ReloadOptionsCommand",
  changeoption: "ChangeOptionCommand",
  banid: "BanSteamIDCommand",
  unbanid: "UnbanSteamIDCommand",
  addSteamID: "AddSteamIDCommand",
  removeSteamID: "RemoveSteamIDCommand",
  voiceban: "VoiceBanCommand",
  alarm: "AlarmCommand",
  reloadlua: "ReloadLuaCommand",
  log: "LogCommand",
  stats: "StatisticsCommand",
  removezombies: "RemoveZombiesCommand",
  // releasesafehouse deliberately NOT listed: rcon.js's releaseSafehouse()
  // throws before ever calling execute() -- the real B42 server refuses this
  // command from any RCON/console caller unconditionally (see rcon.js's own
  // comment there), so the panel never actually transmits it. Including it
  // here would classify a command this panel doesn't send.
};

const ENUMERATION_OWNERS = new Set([
  "java/util/Iterator",
  "java/util/List",
  "java/util/ArrayList",
  "java/util/Map",
  "java/util/Set",
  "java/util/Collection",
]);
const ENUMERATION_METHODS = new Set(["hasNext", "next", "iterator", "entrySet", "keySet", "values"]);

const d = await unzipper.Open.file(jarPath);

const results = [];
for (const [command, className] of Object.entries(RCON_COMMAND_CLASSES)) {
  const entry = d.files.find((f) => f.path === `zombie/commands/serverCommands/${className}.class`);
  if (!entry) {
    results.push({ command, className, verdict: "CLASS_NOT_FOUND" });
    continue;
  }
  const info = parseClass(await entry.buffer());
  const refs = listMethodRefs(info);
  const loopEvidence = refs.some(
    (r) => ENUMERATION_OWNERS.has(r.ownerClass) && ENUMERATION_METHODS.has(r.name),
  );
  // Substantive string constants: UTF8 entries that are not JVM type
  // descriptors/internal names (those start with '(' or a single letter +
  // ';', or contain '/' as a package separator with no spaces -- a crude
  // but effective filter for this narrow purpose).
  const stringCount = info.constantPool.filter((c) => {
    if (!c || c.tag !== 1) return false;
    const v = c.value;
    if (v.length < 3) return false;
    if (v.startsWith("(")) return false;
    if (/^[A-Za-z0-9_$]+(\/[A-Za-z0-9_$]+)*$/.test(v)) return false; // internal class name
    return true;
  }).length;

  const verdict = loopEvidence ? "INFORMATIVE" : "NO_LOOP_EVIDENCE";
  results.push({ command, className, loopEvidence, stringCount, verdict });
}

const asJson = process.argv.includes("--json");
if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    if (r.verdict === "CLASS_NOT_FOUND") {
      console.log(`${r.command.padEnd(24)} CLASS_NOT_FOUND (${r.className})`);
      continue;
    }
    console.log(
      `${r.command.padEnd(24)} ${r.verdict.padEnd(12)} loopEvidence=${r.loopEvidence} stringCount=${r.stringCount}`,
    );
  }
  const counts = results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});
  console.log("\n" + JSON.stringify(counts));
}
