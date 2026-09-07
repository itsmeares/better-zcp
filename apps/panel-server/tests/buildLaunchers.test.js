import { describe, expect, it } from "vitest";
import fs from "fs";
import { generateStartBat, generateStartSh } from "../../../scripts/release/build.mjs";

describe("standalone launchers", () => {
  it("does not promise a fixed URL from the Linux launcher", () => {
    const launcher = generateStartSh();

    expect(launcher).not.toContain("localhost:3001");
    expect(launcher).toContain("./ZomboidControlPanel");
  });

  it("supervises only the Linux panel process and forwards shutdown signals", () => {
    const launcher = generateStartSh();

    expect(launcher).toContain("PANEL_SUPERVISOR_V=2");
    expect(launcher).toContain("setsid ./ZomboidControlPanel");
    expect(launcher).toContain("trap 'stop_panel TERM' TERM");
    expect(launcher).toContain('kill -TERM -- "-$PANEL_PID"');
    expect(launcher).toContain('if [ "$STOPPING" = "1" ]');
    expect(launcher).toContain('if [ "$EXIT_CODE" = "75" ]');
  });

  it("configures systemd to stop only the supervisor main process", () => {
    const unit = fs.readFileSync("infra/services/linux/zomboid-panel.service", "utf8");
    const server = fs.readFileSync("apps/panel-server/index.ts", "utf8");

    expect(unit).toContain("ExecStart=/opt/zomboid-panel/start.sh");
    expect(unit).toContain("KillMode=process");
    expect(server).toContain("process.exit(linuxSupervisor ? 75");
  });

  it("ships an explicit service installer that backs up existing units", () => {
    const installer = fs.readFileSync("infra/services/linux/install-linux-service.sh", "utf8");

    expect(installer).toContain('if [ "$(id -u)" -ne 0 ]');
    expect(installer).toContain('cp -p "$UNIT_TARGET" "$BACKUP"');
    expect(installer).toContain("systemctl daemon-reload");
    expect(installer).not.toMatch(/\bsudo\s+(systemctl|cp|install|chmod)/);
  });

  it("does not promise a fixed URL from the Windows supervisor", () => {
    expect(generateStartBat()).not.toContain("localhost:3001");
  });

  it("preserves Windows separators in generated frontend paths", () => {
    const launcher = generateStartBat();

    expect(launcher).toContain(
      'set "CLIENT_LIVE=%INSTALL_DIR%client\\dist"',
    );
    expect(launcher).toContain('if not exist "!STAGED_CLIENT!\\index.html"');
    expect(launcher).not.toContain("clientdist");
  });

  it("checks that the pending marker becomes the applying marker before launch", () => {
    const launcher = generateStartBat();
    const moveStart = launcher.indexOf('move /y "%MARKER%" "%APPLYING%"');
    const moveFailureCheck = launcher.indexOf("if errorlevel 1", moveStart);
    const activationLog = launcher.indexOf(
      "Apply: bundle activated; waiting for backend startup acknowledgement",
      moveStart,
    );

    expect(moveStart).toBeGreaterThan(-1);
    expect(moveFailureCheck).toBeGreaterThan(moveStart);
    expect(moveFailureCheck).toBeLessThan(activationLog);
  });

  it("retains the update journal unless every rollback restore succeeds", () => {
    const launcher = generateStartBat();
    const rollbackStart = launcher.indexOf(":rollback_update");
    const restoreFailureCheck = launcher.indexOf(
      'if "!ROLLBACK_FAILED!"=="1"',
      rollbackStart,
    );
    const journalDelete = launcher.indexOf('del /f /q "%JOURNAL%"', rollbackStart);

    expect(rollbackStart).toBeGreaterThan(-1);
    expect(restoreFailureCheck).toBeGreaterThan(rollbackStart);
    expect(journalDelete).toBeGreaterThan(restoreFailureCheck);
  });
});
