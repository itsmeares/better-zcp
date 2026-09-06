import { describe, expect, it } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { loadPanelBridge } from "./helpers/panelBridgeLua.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",  "integrations", "panelbridge",
  "PanelBridge",
  "media",
  "lua",
  "server",
  "PanelBridge.lua",
);

function startupPowerStubs({ shutdownDay, worldAgeHours, hydroPowerOn }) {
  return `
SandboxVars = {}
getOnlinePlayers = function() return nil end
getCell = function() return nil end

FakeSandbox = { shutdownDay = ${shutdownDay}, timeSinceApo = 1 }
function FakeSandbox:getElecShutModifier() return self.shutdownDay end
function FakeSandbox:getTimeSinceApo() return self.timeSinceApo end
getSandboxOptions = function() return FakeSandbox end

FakeGameTime = { worldAgeHours = ${worldAgeHours} }
function FakeGameTime:getWorldAgeHours() return self.worldAgeHours end
getGameTime = function() return FakeGameTime end

FakeWorld = { hydroPowerOn = ${hydroPowerOn}, transmissions = 0 }
function FakeWorld:isHydroPowerOn() return self.hydroPowerOn end
function FakeWorld:setHydroPowerOn(value) self.hydroPowerOn = value end
function FakeWorld:transmitWeather() self.transmissions = self.transmissions + 1 end
getWorld = function() return FakeWorld end
`;
}

describe("PanelBridge startup power reconciliation", () => {
  it("restores fresh-world power when the configured shutdown day is still ahead", () => {
    const bridge = loadPanelBridge(
      LUA_PATH,
      startupPowerStubs({ shutdownDay: 14, worldAgeHours: 0, hydroPowerOn: false }),
    );

    bridge.run("RECONCILED = PanelBridgeModule.reconcileStartupPower()");

    expect(bridge.getGlobal("RECONCILED")).toBe(true);
    expect(bridge.getGlobal("FakeWorld")).toMatchObject({
      hydroPowerOn: true,
      transmissions: 1,
    });
  });

  it("does not override an intentional immediate power shutoff", () => {
    const bridge = loadPanelBridge(
      LUA_PATH,
      startupPowerStubs({ shutdownDay: 0, worldAgeHours: 0, hydroPowerOn: false }),
    );

    bridge.run("RECONCILED = PanelBridgeModule.reconcileStartupPower()");

    expect(bridge.getGlobal("RECONCILED")).toBe(false);
    expect(bridge.getGlobal("FakeWorld")).toMatchObject({
      hydroPowerOn: false,
      transmissions: 0,
    });
  });

  it("does not restore power after the configured shutdown day", () => {
    const bridge = loadPanelBridge(
      LUA_PATH,
      startupPowerStubs({ shutdownDay: 14, worldAgeHours: 14 * 24, hydroPowerOn: false }),
    );

    bridge.run("RECONCILED = PanelBridgeModule.reconcileStartupPower()");

    expect(bridge.getGlobal("RECONCILED")).toBe(false);
    expect(bridge.getGlobal("FakeWorld")).toMatchObject({
      hydroPowerOn: false,
      transmissions: 0,
    });
  });
});