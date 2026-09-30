import fs from "node:fs";
import { lua, lauxlib, lualib, to_luastring } from "fengari";

const BASE_STUBS = String.raw`
argusFiles = {}
argusFileWrites = {}
argusNow = 1000
argusServerName = "Argus Fixture"
argusPlayers = {}
argusSandbox = nil
argusScriptManager = nil
argusDamageCalls = 0

Events = {
  OnServerStarted = { Add = function() end },
  OnTickEvenPaused = { Add = function() end },
}
isServer = function() return true end
getTimestampMs = function() return argusNow end
getRandomUUID = function() return "boot-session-1" end
getServerName = function() return argusServerName end
getCore = function() return { getVersion = function() return "42.21.0" end } end
getOnlinePlayers = function()
  return {
    size = function() return #argusPlayers end,
    get = function(_, index) return argusPlayers[index + 1] end,
  }
end
getSandboxOptions = function() return argusSandbox end
getScriptManager = function() return argusScriptManager end
getWorld = function() return { getMap = function() return "Muldraugh, KY" end } end
getGameTime = function()
  return {
    getDay = function() return 1 end,
    getMonth = function() return 0 end,
    getYear = function() return 1993 end,
    getHour = function() return 12 end,
    getMinutes = function() return 34 end,
  }
end
getText = function(key) return "translated:" .. key end
CharacterStat = {
  HUNGER = "hunger", THIRST = "thirst", FATIGUE = "fatigue",
  STRESS = "stress", BOREDOM = "boredom", UNHAPPINESS = "unhappiness",
  PAIN = "pain", ENDURANCE = "endurance",
}
sendDamage = function() argusDamageCalls = argusDamageCalls + 1 end

getFileReader = function(path)
  local contents = argusFiles[path]
  if not contents then error("file not found") end
  local position = 1
  return {
    readLine = function()
      if position > #contents then return nil end
      local newline = contents:find("\n", position, true)
      if not newline then
        local line = contents:sub(position)
        position = #contents + 1
        return line
      end
      local line = contents:sub(position, newline - 1)
      position = newline + 1
      return line
    end,
    close = function() end,
  }
end
getFileWriter = function(path)
  local chunks = {}
  return {
    write = function(_, value) chunks[#chunks + 1] = value end,
    close = function()
      argusFiles[path] = table.concat(chunks)
      argusFileWrites[path] = (argusFileWrites[path] or 0) + 1
    end,
  }
end
`;

function runOrThrow(L: any, code: string, label: string): void {
  const status = lauxlib.luaL_loadstring(L, to_luastring(code));
  if (status !== lua.LUA_OK) {
    const error = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    throw new Error(`[${label}] compile error: ${error}`);
  }
  const result = lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0);
  if (result !== lua.LUA_OK) {
    const error = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    throw new Error(`[${label}] runtime error: ${error}`);
  }
}

function luaToJs(L: any, index: number): any {
  index = lua.lua_absindex(L, index);
  switch (lua.lua_type(L, index)) {
    case lua.LUA_TNIL:
      return null;
    case lua.LUA_TBOOLEAN:
      return lua.lua_toboolean(L, index);
    case lua.LUA_TNUMBER:
      return lua.lua_tonumber(L, index);
    case lua.LUA_TSTRING:
      return lua.lua_tojsstring(L, index);
    case lua.LUA_TTABLE: {
      const entries: Array<[string | number, any]> = [];
      lua.lua_pushnil(L);
      while (lua.lua_next(L, index) !== 0) {
        entries.push([luaToJs(L, -2), luaToJs(L, -1)]);
        lua.lua_pop(L, 1);
      }
      const array = entries.length > 0 && entries.every(
        ([key]) => typeof key === "number" && Number.isInteger(key) && key >= 1 && key <= entries.length,
      );
      if (array) {
        const result = new Array(entries.length);
        for (const [key, value] of entries) result[(key as number) - 1] = value;
        return result;
      }
      return Object.fromEntries(entries.map(([key, value]) => [String(key), value]));
    }
    default:
      return `<lua ${lua.lua_typename(L, lua.lua_type(L, index))}>`;
  }
}

function luaLiteral(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    return `"${value.replace(/[\\"\u0000-\u001f]/g, (char) => {
      const escapes: Record<string, string> = {
        "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t",
      };
      return escapes[char] ?? `\\${char.charCodeAt(0).toString().padStart(3, "0")}`;
    })}"`;
  }
  if (Array.isArray(value)) return `{${value.map(luaLiteral).join(",")}}`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `[${luaLiteral(key)}]=${luaLiteral(item)}`).join(",")}}`;
  }
  throw new Error(`Unsupported Lua literal: ${typeof value}`);
}

export function loadArgus(luaPath: string, extraStubLua = "") {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  runOrThrow(L, BASE_STUBS, "Argus stubs");
  if (extraStubLua) runOrThrow(L, extraStubLua, "Argus fixture");
  runOrThrow(L, fs.readFileSync(luaPath, "utf8"), "Argus.lua");
  lua.lua_setglobal(L, to_luastring("ArgusModule"));
  runOrThrow(L, "ArgusModule.onServerStarted()", "Argus startup");

  return {
    L,
    run(code: string) {
      runOrThrow(L, code, "Argus test snippet");
    },
    callHandler(name: string, args: Record<string, unknown> = {}) {
      runOrThrow(L, `
        local ok, data, err = ArgusModule.handlers[${luaLiteral(name)}](${luaLiteral(args)})
        __argusResult = { ok = ok, data = data, error = err }
      `, `Argus handler ${name}`);
      lua.lua_getglobal(L, to_luastring("__argusResult"));
      const result = luaToJs(L, -1);
      lua.lua_pop(L, 1);
      return result;
    },
    getGlobal(name: string) {
      lua.lua_getglobal(L, to_luastring(name));
      const result = luaToJs(L, -1);
      lua.lua_pop(L, 1);
      return result;
    },
    close() {
      lua.lua_close(L);
    },
  };
}
