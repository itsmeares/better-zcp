import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveAllCallSites,
  SEED_GLOBALS,
  STATIC_CLASS_SEEDS,
} from "../../../scripts/lib/engine-signature-core.mjs";

const LUA_PATH = path.resolve(
  "integrations/argus/Argus/media/lua/server/Argus.lua",
);
const MANIFEST_PATH = path.resolve("scripts/engine-signatures.manifest.json");
const source = fs.readFileSync(LUA_PATH, "utf8");
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
Object.assign(SEED_GLOBALS, manifest.seedGlobals);
Object.assign(STATIC_CLASS_SEEDS, manifest.staticClassSeeds);

const classProvider = (className: string, methodName: string) => {
  const methods = manifest.classes[className]?.methods;
  const signatures = methods?.[methodName];
  return signatures?.length
    ? {
        exists: true,
        returnClass: signatures[0].returnClass,
        elementClass: signatures[0].elementClass,
      }
    : manifest.classes[className]
      ? { exists: false }
      : null;
};

describe("Argus Build 42 engine signature coverage", () => {
  it("checks player, healing, sandbox, and mod item calls against the generated manifest", () => {
    const { callSites } = resolveAllCallSites(source, classProvider);
    const requiredCalls = [
      ["zombie.characters.IsoPlayer", "getBodyDamage"],
      ["zombie.characters.IsoPlayer", "isGodMod"],
      ["zombie.characters.IsoPlayer", "Kill"],
      ["zombie.characters.BodyDamage.BodyDamage", "RestoreToFullHealth"],
      ["zombie.SandboxOptions", "getOptionByName"],
      ["zombie.scripting.ScriptManager", "getAllItems"],
      ["zombie.scripting.objects.Item", "getFullName"],
    ];

    for (const [receiverType, methodName] of requiredCalls) {
      expect(
        callSites.some(
          (site) =>
            site.receiverType === receiverType &&
            site.methodName === methodName &&
            site.methodInfo?.exists,
        ),
        `${receiverType}#${methodName} should be checked against Build 42`,
      ).toBe(true);
    }
    expect(callSites.filter((site) => site.resolved).length).toBeGreaterThanOrEqual(
      75,
    );
  });
});
