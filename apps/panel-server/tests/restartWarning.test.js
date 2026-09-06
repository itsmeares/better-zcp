import { describe, expect, it } from "vitest";
import {
  defaultRestartWarningSettings,
  formatRestartWarning,
  getRestartWarningNotice,
  validateRestartWarningSettings,
} from "../utils/restartWarning.js";

describe("restart warning settings", () => {
  it("renders the Chinese preset for both minute and second countdowns", () => {
    const settings = defaultRestartWarningSettings("zh-CN");

    expect(formatRestartWarning(settings, 5, "minute")).toBe(
      "[服务器] *** 将在 5分钟 后重启 ***",
    );
    expect(formatRestartWarning(settings, 10, "second")).toBe(
      "[服务器] *** 将在 10秒 后重启 ***",
    );
    expect(getRestartWarningNotice(settings, "restarting")).toContain("正在重启");
  });

  it("renders a validated custom template with the selected locale's units", () => {
    const settings = validateRestartWarningSettings({
      locale: "zh-CN",
      template: "请在 {count}{unit} 内到安全地点",
    });

    expect(formatRestartWarning(settings, 1, "minute")).toBe("请在 1分钟 内到安全地点");
  });

  it("rejects unsafe command delimiters, controls, and unsupported placeholders", () => {
    for (const template of [
      'Restart in {count} {unit} "quit',
      "Restart in {count} {unit}\nquit",
      "Restart in {minutes}",
      "Restart ⚠ {count} {unit}",
    ]) {
      expect(() =>
        validateRestartWarningSettings({ locale: "en", template }),
      ).toThrow();
    }
  });
});