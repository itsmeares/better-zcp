import { describe, expect, it } from "vite-plus/test";
import { modifySandboxValue } from "../services/sandboxPersistence.ts";
import { lua, lauxlib, lualib, to_luastring } from "fengari";
function evaluate(content: string, expression: string): string {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const code = content + "\nreturn tostring(" + expression + ")";
  expect(lauxlib.luaL_loadstring(state, to_luastring(code))).toBe(lua.LUA_OK);
  expect(lua.lua_pcall(state, 0, 1, 0)).toBe(lua.LUA_OK);
  return lua.lua_tojsstring(state, -1);
}
describe("sandbox options", () => {
  it("updates the intended table without altering same-named mod fields or strings", () => {
    const source = 'SandboxVars = {\n -- Zombies = 9,\n Zombies = 3,\n Custom = { Zombies = 5, Text = "}, Zombies = 7,", Nested = { X = 1, }, },\n}';
    const result = modifySandboxValue(source, "Zombies", 1);
    expect(evaluate(result, "SandboxVars.Zombies")).toBe("1");
    expect(evaluate(result, "SandboxVars.Custom.Zombies")).toBe("5");
    const nested = modifySandboxValue(result, "Text", 'line\n"quoted"[x]\\', "Custom");
    expect(evaluate(nested, "SandboxVars.Custom.Text")).toBe('line\n"quoted"[x]\\');
  });
  it("adds missing mod fields/groups as valid Lua even when the last field has no comma", () => {
    const source = 'SandboxVars = { Zombies = 3 -- last\n}';
    const result = modifySandboxValue(source, "Enabled", true, "Custom", true);
    expect(evaluate(result, "SandboxVars.Custom.Enabled")).toBe("true");
    const again = modifySandboxValue(result, "Amount", 4.5, "Custom", true);
    expect(evaluate(again, "SandboxVars.Custom.Amount")).toBe("4.5");
  });
  it("rejects nonliteral or malformed data before altering the config", () => {
    expect(() => modifySandboxValue("SandboxVars = { Zombies = calculate(), }", "Zombies", 1)).toThrow("literal");
    expect(() => modifySandboxValue("SandboxVars = { Zombies = 3", "Zombies", 1)).toThrow("unclosed");
    expect(() => modifySandboxValue("SandboxVars = {}", "X", NaN)).toThrow("finite");
  });
});
