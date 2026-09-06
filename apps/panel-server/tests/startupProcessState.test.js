import { describe, expect, it } from "vitest";
import { classifyStartupProcessState } from "../index.js";

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

  it("uses direct signals for remote servers without local process scanning", () => {
    expect(
      classifyStartupProcessState({ running: true, scanFailed: true }, true),
    ).toEqual({ running: true, unknown: false });
  });
});
