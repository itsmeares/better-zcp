import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { loadArgus } from "./helpers/argusLua.ts";

const LUA_PATH = path.resolve(
  "integrations/argus/Argus/media/lua/server/Argus.lua",
);

const PLAYER_FIXTURE = String.raw`
local bodyPart = {
  health = 40,
  fakeInfected = true,
  RestoreToFullHealth = function(self) self.health = 100 end,
  SetFakeInfected = function(self, value) self.fakeInfected = value end,
}
local parts = {
  size = function() return 1 end,
  get = function(_, index) if index == 0 then return bodyPart end end,
}
local body = {
  getBodyParts = function() return parts end,
  getNumPartsBleeding = function() return 0 end,
  getOverallBodyHealth = function() return bodyPart.health end,
  IsInfected = function() return bodyPart.fakeInfected end,
  getHealth = function() return bodyPart.health end,
  RestoreToFullHealth = function()
    bodyPart:RestoreToFullHealth()
    bodyPart:SetFakeInfected(false)
    argusBodyRestoreCalls = (argusBodyRestoreCalls or 0) + 1
  end,
}
local stats = {
  get = function(_, key)
    local values = { hunger = 0.2, thirst = 0.3, fatigue = 0.4, stress = 0.1, boredom = 0.05, unhappiness = 0, pain = 0, endurance = 0.7 }
    return values[key]
  end,
}
local player = {
  x = 100.25, y = 200.5, z = 0, dead = false, god = true,
  getUsername = function(self) return "Ada" end,
  getDisplayName = function(self) return "Ada Player" end,
  getX = function(self) return self.x end,
  getY = function(self) return self.y end,
  getZ = function(self) return self.z end,
  getAccessLevel = function() return "admin" end,
  isAlive = function(self) return not self.dead end,
  isDead = function(self) return self.dead end,
  isAsleep = function() return false end,
  isSneaking = function() return false end,
  isRunning = function() return true end,
  isGodMod = function(self) return self.god end,
  setGodMod = function(self, value) self.god = value end,
  isInvisible = function() return true end,
  isNoClip = function() return false end,
  getBodyDamage = function() return body end,
  getStats = function() return stats end,
  Kill = function(self) if self.god then error("god mode prevents kill") end; self.dead = true end,
}
argusPlayers = { player }
`;

function response(argus: ReturnType<typeof loadArgus>) {
  const files = argus.getGlobal("argusFiles") as Record<string, string>;
  return JSON.parse(files["argus/Argus Fixture/response.json.txt"]);
}

describe("Argus Build 42 server Lua", () => {
  it("writes a live heartbeat under the exact configured server path", () => {
    const argus = loadArgus(LUA_PATH, PLAYER_FIXTURE);
    try {
      argus.run("argusNow = 2001; ArgusModule.onTick()");
      const files = argus.getGlobal("argusFiles") as Record<string, string>;
      const status = JSON.parse(files["argus/Argus Fixture/status.json.txt"]);
      expect(status).toMatchObject({
        protocol: 1,
        version: "1.0.0",
        session: "boot-session-1",
        serverName: "Argus Fixture",
        playerCount: 1,
        players: ["Ada"],
        world: { serverName: "Argus Fixture", map: "Muldraugh, KY" },
      });
      expect(status.playerDetails[0]).toMatchObject({
        username: "Ada",
        displayName: "Ada Player",
        x: 100.25,
        y: 200.5,
        isAlive: true,
        isRunning: true,
        godMod: true,
        invisible: true,
        noclip: false,
        stats: { hunger: 0.2, thirst: 0.3, fatigue: 0.4 },
        health: { overallBodyHealth: 40, isInfected: true, isBleeding: false },
      });
      expect(argus.getGlobal("ArgusModule")).toBeTruthy();
      argus.run("__hasCoordinateTeleport = ArgusModule.handlers.teleportPlayer == nil");
      expect(argus.getGlobal("__hasCoordinateTeleport")).toBe(true);
    } finally {
      argus.close();
    }
  });

  it("serializes one request for the current boot session and rejects replay", () => {
    const argus = loadArgus(LUA_PATH);
    try {
      argus.run(String.raw`
        local option = {
          value = 1,
          getName = function() return "ZombieRate" end,
          getClass = function() return "IntegerSandboxOption" end,
          getValue = function(self) return self.value end,
          getMin = function() return 0 end,
          getMax = function() return 10 end,
          getDefaultValue = function() return 1 end,
          setValue = function(self, value) self.value = value; argusSetCalls = (argusSetCalls or 0) + 1 end,
        }
        argusSandbox = {
          getOptionByName = function(_, name) if name == "ZombieRate" then return option end end,
          getNumOptions = function() return 1 end,
          getOptionByIndex = function(_, index) if index == 0 then return option end end,
          toLua = function() end,
        }
        argusFiles["argus/Argus Fixture/request.json"] = '{"id":"one-request","session":"boot-session-1","action":"setSandboxOption","args":{"name":"ZombieRate","value":7},"expiresAt":15000}'
        ArgusModule.onTick()
      `);
      expect(response(argus)).toMatchObject({ id: "one-request", session: "boot-session-1", success: true, data: { value: 7, verified: true } });
      expect(argus.getGlobal("argusSetCalls")).toBe(1);

      const writeCounts = argus.getGlobal("argusFileWrites") as Record<string, number>;
      const responseWrites = writeCounts["argus/Argus Fixture/response.json.txt"];
      argus.run("argusNow = 1300; ArgusModule.onTick()");
      expect(argus.getGlobal("argusSetCalls")).toBe(1);
      expect((argus.getGlobal("argusFileWrites") as Record<string, number>)["argus/Argus Fixture/response.json.txt"]).toBe(responseWrites);

      argus.run(String.raw`
        argusFiles["argus/Argus Fixture/request.json"] = '{"id":"wrong-session","session":"prior-boot","action":"ping","args":{},"expiresAt":15000}'
        argusNow = 1600
        ArgusModule.onTick()
      `);
      expect(response(argus)).toMatchObject({ id: "wrong-session", success: false, error: "Request belongs to a different server session" });
    } finally {
      argus.close();
    }
  });

  it("returns typed, one-based sandbox metadata and rejects coercion or clamping", () => {
    const argus = loadArgus(LUA_PATH);
    try {
      argus.run(String.raw`
        local enumOption = {
          value = 1,
          getName = function() return "ZombieLore.Speed" end,
          getShortName = function() return "Speed" end,
          getTableName = function() return "ZombieLore" end,
          getClass = function() return "EnumSandboxOption" end,
          getValue = function(self) return self.value end,
          getDefaultValue = function() return 1 end,
          getNumValues = function() return 3 end,
          getValueTranslationByIndexOrNull = function(_, index) return ({ "Fast", "Normal", "Slow" })[index] end,
          setValue = function(self, value) self.value = value end,
        }
        local integerOption = {
          value = 2,
          getName = function() return "ZombieLore.Population" end,
          getTableName = function() return "ZombieLore" end,
          getClass = function() return "IntegerSandboxOption" end,
          getValue = function(self) return self.value end,
          getMin = function() return 0 end,
          getMax = function() return 10 end,
          getDefaultValue = function() return 2 end,
          setValue = function(self, value) self.value = value end,
        }
        local options = { enumOption, integerOption }
        argusSandbox = {
          getNumOptions = function() return #options end,
          getOptionByIndex = function(_, index) return options[index + 1] end,
          getOptionByName = function(_, name)
            for _, option in ipairs(options) do if option:getName() == name then return option end end
          end,
          toLua = function() end,
        }
      `);
      const metadata = argus.callHandler("getAllSandboxOptions");
      expect(metadata.ok).toBe(true);
      expect(metadata.data.options.ZombieLore.find((option: any) => option.name === "ZombieLore.Speed")).toMatchObject({
        type: "enum", min: 1, max: 3, selectedIndex: 1, enumValues: ["Fast", "Normal", "Slow"],
      });
      expect(metadata.data.options.ZombieLore.find((option: any) => option.name === "ZombieLore.Population")).toMatchObject({
        type: "integer", min: 0, max: 10,
      });

      expect(argus.callHandler("setSandboxOption", { name: "ZombieLore.Speed", value: 2 })).toMatchObject({
        ok: true, data: { value: 2, verified: true, applied: true },
      });
      for (const value of [0, 4, 2.5, "2"]) {
        expect(argus.callHandler("setSandboxOption", { name: "ZombieLore.Speed", value })).toMatchObject({ ok: false });
      }
      expect(argus.callHandler("setSandboxOption", { name: "ZombieLore.Population", value: 4.5 })).toMatchObject({ ok: false });
      expect(argus.callHandler("setSandboxOption", { name: "ZombieLore.Population", value: 11 })).toMatchObject({ ok: false });
    } finally {
      argus.close();
    }
  });

  it("heals and kills through server player objects with read-back and damage sync", () => {
    const argus = loadArgus(LUA_PATH, PLAYER_FIXTURE);
    try {
      expect(argus.callHandler("healPlayer", { username: "Ada" })).toMatchObject({
        ok: true, data: { username: "Ada", health: 100, verified: true, applied: true },
      });
      expect(argus.getGlobal("argusDamageCalls")).toBe(1);
      expect(argus.getGlobal("argusBodyRestoreCalls")).toBe(1);

      expect(argus.callHandler("killPlayer", { username: "Ada" })).toMatchObject({
        ok: true, data: { username: "Ada", isDead: true, verified: true },
      });
      expect(argus.getGlobal("argusDamageCalls")).toBe(2);
      expect(argus.run("__dead = argusPlayers[1].dead; __god = argusPlayers[1].god")).toBeUndefined();
      expect(argus.getGlobal("__dead")).toBe(true);
      expect(argus.getGlobal("__god")).toBe(false);
    } finally {
      argus.close();
    }
  });

  it("does not claim god mode was restored when the failed kill path cannot read it back", () => {
    const argus = loadArgus(LUA_PATH, PLAYER_FIXTURE);
    try {
      argus.run(String.raw`
        argusPlayers[1].Kill = function() error("kill blocked") end
        argusPlayers[1].setGodMod = function(self, value)
          if value == false then self.god = false end
        end
      `);
      const result = argus.callHandler("killPlayer", { username: "Ada" });
      expect(result).toMatchObject({
        ok: false,
        data: { isDead: false, godModeRestored: false },
      });
      expect(argus.getGlobal("argusPlayers")[0].god).toBe(false);
    } finally {
      argus.close();
    }
  });

  it("reads the item list through the shipped script manager API", () => {
    const argus = loadArgus(LUA_PATH);
    try {
      argus.run(String.raw`
        local items = {
          {
            getFullName = function() return "Base.Axe" end,
            getDisplayName = function() return "Axe" end,
            getDisplayCategory = function() return "Weapon" end,
            getActualWeight = function() return 2.5 end,
          },
        }
        argusScriptManager = {
          getAllItems = function()
            return {
              size = function() return #items end,
              get = function(_, index) return items[index + 1] end,
            }
          end,
        }
      `);
      expect(argus.callHandler("getItemCatalog")).toMatchObject({
        ok: true,
        data: { count: 1, items: [{ id: "Base.Axe", name: "Axe", category: "Weapon", weight: 2.5 }] },
      });
    } finally {
      argus.close();
    }
  });
});
