import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(__dirname, "../routes/serverFiles.js"),
  "utf8",
);

// serverFiles.js pulls in the whole app graph on import, so lift the two pure
// helpers out of the source instead of booting the router just to test them.
function extractFn(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in serverFiles.js`);
  let depth = 0;
  let i = source.indexOf("{", start);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) break;
  }
  return { header: source.slice(start, open), body: source.slice(open, i + 1) };
}

const unescapeSrc = extractFn("unescapeLuaString");
const escapeSrc = extractFn("escapeLuaString");
const tableStart = source.indexOf("const LUA_UNESCAPES = {");
const tableEnd = source.indexOf("};", tableStart) + 2;
const luaTable = source.slice(tableStart, tableEnd);

const { escapeLuaString, unescapeLuaString } = new Function(
  `${luaTable}
   ${escapeSrc.header}${escapeSrc.body}
   ${unescapeSrc.header}${unescapeSrc.body}
   return { escapeLuaString, unescapeLuaString };`,
)();

const quote = (v) => `"${escapeLuaString(v)}"`;

describe("SandboxVars Lua string round trip", () => {
  const values = [
    "",
    "plain text",
    "a\\b",
    "\\",
    "\\\\",
    "C:\\Users\\zomboid",
    'has "quotes" inside',
    "comma,separated,list",
    "bracket[0]",
    "line\nbreak\ttab",
    "location_sewer_01_32,location_sewer_01_33",
  ];

  it.each(values)("survives one write/read cycle: %j", (value) => {
    expect(unescapeLuaString(quote(value))).toBe(value);
  });

  // The actual defect: each save re-escaped what the previous save escaped,
  // doubling every backslash until the file was unusable.
  it("stays byte-stable across 20 save cycles", () => {
    const original = "C:\\path\\to\\sprite,\\other";
    let onDisk = quote(original);
    for (let i = 0; i < 20; i++) {
      onDisk = quote(unescapeLuaString(onDisk));
    }
    expect(unescapeLuaString(onDisk)).toBe(original);
    expect((onDisk.match(/\\/g) || []).length).toBe(
      (quote(original).match(/\\/g) || []).length,
    );
  });

  it("does not grow a backslash-only value", () => {
    let onDisk = '"\\\\"';
    const first = onDisk;
    for (let i = 0; i < 10; i++) {
      onDisk = quote(unescapeLuaString(onDisk));
    }
    expect(onDisk).toBe(first);
  });

  it("leaves unquoted values alone", () => {
    expect(unescapeLuaString("true")).toBe("true");
    expect(unescapeLuaString("Base.Axe")).toBe("Base.Axe");
  });
});
