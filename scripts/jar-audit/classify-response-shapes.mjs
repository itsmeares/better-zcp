#!/usr/bin/env node

import unzipper from "unzipper";
import { parseClass, listMethodRefs } from "./classfile-parser.mjs";

const jarPath = process.argv[2];
if (!jarPath) {
  console.error("Usage: node classify-response-shapes.mjs <path-to-projectzomboid.jar>");
  process.exit(1);
}

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
  const stringCount = info.constantPool.filter((c) => {
    if (!c || c.tag !== 1) return false;
    const v = c.value;
    if (v.length < 3) return false;
    if (v.startsWith("(")) return false;
    if (/^[A-Za-z0-9_$]+(\/[A-Za-z0-9_$]+)*$/.test(v)) return false;
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
