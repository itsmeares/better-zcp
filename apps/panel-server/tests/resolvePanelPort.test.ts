import { describe, expect, it, vi } from "vitest";
import { resolvePanelPort } from "../index.ts";

describe("resolvePanelPort", () => {
  it("accepts valid ports and warns when it falls back", () => {
    const onInvalid = vi.fn();

    expect(resolvePanelPort("8443", { onInvalid })).toBe(8443);
    expect(resolvePanelPort("not-a-port", { onInvalid })).toBe(3001);
    expect(resolvePanelPort(65536, { onInvalid })).toBe(3001);
    expect(onInvalid).toHaveBeenCalledTimes(2);
  });

  it("does not warn for an omitted value", () => {
    const onInvalid = vi.fn();

    expect(resolvePanelPort(undefined, { onInvalid })).toBe(3001);
    expect(resolvePanelPort("", { onInvalid })).toBe(3001);
    expect(onInvalid).not.toHaveBeenCalled();
  });
});
