import { describe, expect, it } from "vitest";
import { getPanelRuntime, setPanelRuntime } from "../utils/panelRuntime.ts";

describe("panel runtime bridge", () => {
  it("stores the runtime on the process global shared by bundled modules", () => {
    const runtime = { marker: "host-runtime" };

    setPanelRuntime(runtime);

    expect(getPanelRuntime()).toBe(runtime);
  });
});
