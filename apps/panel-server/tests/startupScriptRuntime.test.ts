import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateStartupScripts } from "../services/serverLaunch.ts";
import { buildWindowsCmdLine } from "../services/serverManager.ts";

const isWindows = process.platform === "win32";
const javaHome =
  process.env.LAUNCHER_TEST_JAVA_HOME ||
  process.env.JAVA_HOME_17_X64 ||
  process.env.JAVA_HOME;

describe("generated startup scripts through the real shell and Java", () => {
  it.skipIf(!isWindows && !javaHome)(
    "preserves passwords and paths without executing shell payloads",
    () => {
      if (!javaHome)
        throw new Error(
          "Set LAUNCHER_TEST_JAVA_HOME to a JDK to run the launcher round trip.",
        );
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-launch-"));
      try {
        fs.symlinkSync(
          javaHome,
          path.join(root, "jre64"),
          isWindows ? "junction" : "dir",
        );
        const source = path.join(root, "GameServer.java");
        fs.writeFileSync(
          source,
          `package zombie.network;
import java.util.Base64;
import java.nio.charset.StandardCharsets;
public class GameServer {
  public static void main(String[] args) {
    for (String arg : args) System.out.println("ARG:" + Base64.getEncoder().encodeToString(arg.getBytes(StandardCharsets.UTF_8)));
  }
}`,
        );
        const compile = spawnSync(
          path.join(javaHome, "bin", isWindows ? "javac.exe" : "javac"),
          ["-d", path.join(root, "java"), source],
          { encoding: "utf8" },
        );
        expect(compile.status, compile.stderr).toBe(0);
        const dataPath = path.join(
          root,
          isWindows
            ? "PZ (fixture) & ! %USERNAME% ^ data ü"
            : 'PZ (fixture) & ! %USERNAME% ^ "data" ü',
        );
        fs.mkdirSync(dataPath);
        const passwords = [
          "Start!42",
          "apostrophe's password",
          "trailing\\",
          "trailing\\\\",
          '  a&b|c<d>e^f%USERNAME%"h`i;j$k(l)m{n}o[p]q!r ü.. \\" tail\\  ',
          'x" & echo INJECTED>injected.txt & rem " $(touch injected.txt) `touch injected.txt`',
        ];
        for (const password of passwords) {
          const scripts = generateStartupScripts({
            serverName: "Launch Fixture",
            adminPassword: password,
            zomboidDataPath: dataPath,
            minMemory: 1,
            maxMemory: 1,
            serverPort: 16262,
            useNoSteam: true,
          });
          const launcher = path.join(
            root,
            isWindows ? "StartServer.bat" : "start-server.sh",
          );
          fs.writeFileSync(
            launcher,
            isWindows
              ? scripts.bat.replace("PAUSE", "exit /b %ERRORLEVEL%")
              : scripts.sh,
          );
          const launched = isWindows
            ? spawnSync(
                "cmd.exe",
                ["/d", "/v:on", "/c", buildWindowsCmdLine(launcher, [], null)],
                {
                  cwd: root,
                  encoding: "utf8",
                  windowsVerbatimArguments: true,
                  timeout: 30000,
                },
              )
            : spawnSync("bash", [launcher], {
                cwd: root,
                encoding: "utf8",
                timeout: 30000,
              });
          expect(launched.status, launched.stderr + launched.stdout).toBe(0);
          const args = launched.stdout
            .split(/\r?\n/)
            .filter((line) => line.startsWith("ARG:"))
            .map((line) =>
              Buffer.from(line.slice(4), "base64").toString("utf8"),
            );
          expect(args).toEqual([
            "-servername",
            "Launch Fixture",
            "-cachedir=" + dataPath,
            "-adminpassword",
            password,
            "-port",
            "16262",
            "-nosteam",
          ]);
          expect(fs.existsSync(path.join(root, "injected.txt"))).toBe(false);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );
});
