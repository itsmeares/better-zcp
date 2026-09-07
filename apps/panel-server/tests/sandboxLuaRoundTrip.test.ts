import { describe, it, expect } from "vitest";
import {
  escapeLuaString,
  unescapeLuaString,
} from "../routes/serverFiles.ts";

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
