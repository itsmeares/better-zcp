// Loads the real integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua under
// fengari (a pure-JS Lua 5.3 VM) so its handler logic can be exercised from
// vitest, with fake game-global stubs (getWorld, getSandboxOptions, etc.)
// standing in for Project Zomboid's real API.
//
// HONEST LIMIT -- read this before trusting a green run of anything built on
// this harness: every stub here encodes OUR BELIEF about what a PZ object's
// method looks like (name, arguments, return shape), sourced from reading
// the game's real B42 jar by hand. It is NOT the game itself, and nothing
// here talks to a running PZ instance. A test passing means "PanelBridge.lua's
// logic does what we intended, given inputs shaped the way we believe PZ
// shapes them." It does NOT mean "verified against Project Zomboid." If a
// stub's shape is wrong -- PZ renames a method, changes an arg, changes what
// a getter returns on some game version -- every test built on that stub can
// stay green while the real mod is broken. Kevin's PZ-B42-jar-verified
// (receiver, method) findings and the corresponding real B42 jar audit are
// the actual verified-against-truth work; this harness tests logic sitting
// on top of that, not the truth of the API surface itself.
import fs from 'fs';
import { lua, lauxlib, lualib, to_luastring } from 'fengari';

// Minimal top-level stubs every load needs, regardless of which handler a
// test is exercising -- PanelBridge.lua's own bottom-of-file event
// registration (Events.OnServerStarted.Add / Events.OnTickEvenPaused.Add)
// runs unconditionally at load time, and isServer() is checked nearby.
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

// Recursively converts the Lua value at the given stack index into a plain
// JS value. Does not pop -- caller owns stack discipline. A table with keys
// forming a contiguous 1..n integer sequence becomes a JS array (matches how
// PanelBridge.lua itself builds lists via table.insert); anything else
// becomes a plain object with string keys. A Lua nil field is simply absent
// from the resulting object (Lua's own nil-omits-the-key semantics), not
// present as an explicit null -- callers asserting on an absent field should
// accept both undefined and null.
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
        lua.lua_pop(L, 1); // pop value, keep key for next lua_next
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
      // function/userdata/thread -- not JSON-shaped, describe it instead of
      // silently coercing to null (a test asserting on this is a test bug).
      return `<lua ${lua.lua_typename(L, t)}>`;
  }
}

// Renders a plain JS value (string/number/boolean/null/array/object) as a
// Lua literal, for building one-off argument tables from a test. Deliberately
// narrow -- this is for handler ARGS, which are always plain JSON-shaped
// data in the real system (they arrive over the file-based IPC as JSON).
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

/**
 * Loads the real PanelBridge.lua under a fresh fengari state, with the given
 * extra Lua source injected as game-global stubs before the mod file runs.
 * Returns a handle for calling handlers.* and running arbitrary follow-up
 * Lua snippets against the same state.
 *
 * extraStubLua: a Lua source string defining any of getWorld, getSandboxOptions,
 * getPlayerByUsername, etc. that the handler(s) under test touch.
 */
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
    /** Run an arbitrary Lua snippet against the loaded state (e.g. to flip a fake's state between calls). */
    run(code) {
      runOrThrow(L, code, 'test-snippet');
    },
    /**
     * Calls PanelBridgeModule.handlers[name](args) and returns
     * { ok, data, err } as plain JS values, matching the (ok, data, err)
     * contract every handler in PanelBridge.lua follows.
     */
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
    /** Reads a global's current value as plain JS (e.g. a fake's call counter). */
    getGlobal(name) {
      lua.lua_getglobal(L, to_luastring(name));
      const value = luaToJs(L, -1);
      lua.lua_pop(L, 1);
      return value;
    },
  };
}
