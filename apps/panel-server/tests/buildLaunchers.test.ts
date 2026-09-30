import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import { generateStartBat, generateStartSh } from "../../../scripts/release/build.mjs";
describe("native launchers", () => {
  it("uses the same packaged supervisor on both platforms", () => { expect(generateStartBat()).toContain("ZomboidControlPanel.exe"); expect(generateStartSh()).toContain("--panel-supervisor"); });
  it("systemd stops only the supervisor and retains the configured game cgroup", () => {
    const unit = fs.readFileSync("infra/services/linux/zomboid-panel.service", "utf8");
    expect(unit).toContain("ExecStart=/opt/zomboid-panel/start.sh"); expect(unit).toContain("KillMode=process");
    const installer = fs.readFileSync("infra/services/linux/install-linux-service.sh", "utf8"); expect(installer).toContain('cp -p "$UNIT_TARGET" "$BACKUP"');
  });
});
