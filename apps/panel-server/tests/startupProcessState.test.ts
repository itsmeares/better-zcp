import { describe, expect, it } from "vitest";
import { classifyStartupProcessState } from "../index.ts";

describe("startup process-state classification", () => {
  it("does not treat a failed local scan as a confirmed stop", () => {
    expect(
      classifyStartupProcessState({ running: false, scanFailed: true }),
    ).toEqual({ running: false, unknown: true });
  });

  it("allows auto-start only after a confirmed local stop", () => {
    expect(
      classifyStartupProcessState({ running: false, scanFailed: false }),
    ).toEqual({ running: false, unknown: false });
  });
});
