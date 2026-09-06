import { describe, expect, it } from "vitest";
import { platformTranslationKey } from "../useRuntimeInfo";

describe("platformTranslationKey", () => {
  it("selects Windows, POSIX, and neutral help independently", () => {
    expect(platformTranslationKey("path.help", "windows")).toBe("path.helpWindows");
    expect(platformTranslationKey("path.help", "posix")).toBe("path.helpPosix");
    expect(platformTranslationKey("path.help", "unknown")).toBe("path.help");
    expect(platformTranslationKey("path.help", undefined)).toBe("path.help");
  });
});
