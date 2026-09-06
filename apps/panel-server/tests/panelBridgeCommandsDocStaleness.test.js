import { describe, expect, it } from "vitest";
import { VALID_ACTIONS } from "../routes/panelBridge.js";
import { default as router } from "../routes/panelBridge.js";

function getCommandsHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/commands" && entry.route.methods.get,
  );
  return layer.route.stack[0].handle;
}

function invokeGetCommands() {
  let body = null;
  const res = { json: (payload) => { body = payload; } };
  getCommandsHandler()({}, res);
  return body;
}

describe("GET /panel-bridge/commands: no stale entries", () => {
  it("every documented action is still a real member of VALID_ACTIONS", () => {
    const { commands } = invokeGetCommands();
    const staleEntries = commands
      .map((c) => c.action)
      .filter((action) => !VALID_ACTIONS.has(action));

    expect(
      staleEntries,
      staleEntries.length
        ? `Documented but no longer in VALID_ACTIONS (would 400 "Unknown or invalid action" if actually called): ${staleEntries.join(", ")}. Remove the stale doc entry, the same way addLamppost/removeLamppost were just removed here.`
        : "",
    ).toEqual([]);
  });
});
