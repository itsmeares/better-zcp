import { describe, expect, it } from "vitest";
import { buildPanelHealthPayload } from "../utils/panelHealth.ts";

describe("panel health payload", () => {
  it("keeps the Express and Start response contract stable", () => {
    expect(
      buildPanelHealthPayload(
        {
          panelVersion: "2.0.0",
          buildSha: "test-build",
          apiContractVersion: 1,
        },
        new Date("2026-09-10T00:00:00.000Z"),
      ),
    ).toEqual({
      status: "ok",
      version: "2.0.0",
      panelVersion: "2.0.0",
      buildSha: "test-build",
      apiContractVersion: 1,
      timestamp: "2026-09-10T00:00:00.000Z",
    });
  });
});
