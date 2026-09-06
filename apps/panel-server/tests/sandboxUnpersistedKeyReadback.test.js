import { describe, expect, it } from "vitest";

const { applySandboxChanges, parseSandboxVars, findUnpersistedSandboxKeys } =
  await import("../routes/serverFiles.js");

// PUT /sandbox used to write applySandboxChanges()'s output and report
// success unconditionally -- but modifySandboxValue() (which
// applySandboxChanges calls per key) silently returns its input unchanged
// when a key's regex finds no matching line to update. A key absent from the
// file, or living in a block the writer doesn't parse, was dropped with no
// signal. findUnpersistedSandboxKeys() is the read-back that closes that gap:
// re-parse what actually landed and diff it against what was submitted.
describe("findUnpersistedSandboxKeys", () => {
  const content = [
    "SandboxVars = {",
    "    VERSION = 4,",
    "    Zombies = 3,",
    "    ZombieLore = {",
    "        Speed = 2,",
    "    },",
    "}",
  ].join("\n");

  it("reports no unpersisted keys when every submitted key round-trips", () => {
    const changes = { settings: { Zombies: 1 }, ZombieLore: { Speed: 4 } };
    const written = applySandboxChanges(content, changes);
    const persisted = parseSandboxVars(written);

    expect(findUnpersistedSandboxKeys(changes, persisted)).toEqual([]);
    expect(persisted.settings.Zombies).toBe(1);
    expect(persisted.ZombieLore.Speed).toBe(4);
  });

  // The exact silent-drop this closes: a key with no matching line in the
  // file (never present, wrong block, whatever) is left byte-for-byte
  // unchanged by modifySandboxValue -- proving the old "no exception thrown"
  // signal alone would have reported this as a successful save.
  it("flags a top-level key that has no line to update in the file", () => {
    const changes = { settings: { NotARealSetting: 99 } };
    const written = applySandboxChanges(content, changes);

    expect(written).toBe(content); // the write was a silent no-op
    const persisted = parseSandboxVars(written);
    expect(findUnpersistedSandboxKeys(changes, persisted)).toEqual([
      "NotARealSetting",
    ]);
  });

  it("flags a nested-block key with no matching line, namespaced to its block", () => {
    const changes = { ZombieLore: { StrengthUnknown: 1 } };
    const written = applySandboxChanges(content, changes);

    expect(written).toBe(content); // the write was a silent no-op
    const persisted = parseSandboxVars(written);
    expect(findUnpersistedSandboxKeys(changes, persisted)).toEqual([
      "ZombieLore.StrengthUnknown",
    ]);
  });

  it("does not flag Music/Debug keys since no writer ever attempts them", () => {
    const musicAndDebug = {
      Music: { StrengthMultiplier: 5 },
      Debug: { CheatMode: true },
    };
    const persisted = parseSandboxVars(content);
    expect(findUnpersistedSandboxKeys(musicAndDebug, persisted)).toEqual([]);
  });
});
