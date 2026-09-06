import fs from 'fs';
import { lua, lauxlib, lualib, to_luastring } from 'fengari';

const BASE_STUBS = `
Events = {
  OnServerStarted = { Add = function() end },
  OnTickEvenPaused = { Add = function() end },
}
isServer = function() return true end
getTimestampMs = function() return 0 end
`;

function runOrThrow(L, code, label) {
  const st = lauxlib.luaL_loadstring(L, to_luastring(code));
  if (st !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    throw new Error(`[${label || 'lua'}] compile error: ${err}`);
  }
  const rc = lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0);
  if (rc !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    throw new Error(`[${label || 'lua'}] runtime error: ${err}`);
  }
}

function luaToJs(L, index) {
  index = lua.lua_absindex(L, index);
  const t = lua.lua_type(L, index);
  switch (t) {
    case lua.LUA_TNIL:
      return null;
    case lua.LUA_TBOOLEAN:
      return lua.lua_toboolean(L, index);
    case lua.LUA_TNUMBER:
      return lua.lua_tonumber(L, index);
    case lua.LUA_TSTRING:
      return lua.lua_tojsstring(L, index);
    case lua.LUA_TTABLE: {
      const entries = [];
      lua.lua_pushnil(L);
      while (lua.lua_next(L, index) !== 0) {
        const key = luaToJs(L, -2);
        const value = luaToJs(L, -1);
        entries.push([key, value]);
        lua.lua_pop(L, 1);
      }
      const isArray = entries.length > 0 && entries.every(
        ([k], i) => typeof k === 'number' && k === i + 1,
      );
      if (isArray) return entries.map(([, v]) => v);
      const obj = {};
      for (const [k, v] of entries) obj[String(k)] = v;
      return obj;
    }
    default:
      return `<lua ${lua.lua_typename(L, t)}>`;
  }
}

function jsToLuaLiteral(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (Array.isArray(value)) return `{${value.map(jsToLuaLiteral).join(', ')}}`;
  if (typeof value === 'object') {
    const parts = Object.entries(value).map(([k, v]) => `[${jsToLuaLiteral(k)}] = ${jsToLuaLiteral(v)}`);
    return `{${parts.join(', ')}}`;
  }
  throw new Error(`jsToLuaLiteral: unsupported value ${JSON.stringify(value)}`);
}

export function loadPanelBridge(luaPath, extraStubLua = '') {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  runOrThrow(L, BASE_STUBS, 'base-stubs');
  if (extraStubLua) runOrThrow(L, extraStubLua, 'test-stubs');

  const src = fs.readFileSync(luaPath, 'utf8');
  runOrThrow(L, src, 'PanelBridge.lua');
  lua.lua_setglobal(L, to_luastring('PanelBridgeModule'));

  return {
    L,
    run(code) {
      runOrThrow(L, code, 'test-snippet');
    },
    callHandler(name, args = {}) {
      const argsLua = jsToLuaLiteral(args);
      runOrThrow(L, `
        local __ok, __data, __err = PanelBridgeModule.handlers.${name}(${argsLua})
        __LAST_RESULT = { ok = __ok, data = __data, err = __err }
      `, `call ${name}`);
      lua.lua_getglobal(L, to_luastring('__LAST_RESULT'));
      const result = luaToJs(L, -1);
      lua.lua_pop(L, 1);
      return result;
    },
    getGlobal(name) {
      lua.lua_getglobal(L, to_luastring(name));
      const value = luaToJs(L, -1);
      lua.lua_pop(L, 1);
      return value;
    },
  };
}
