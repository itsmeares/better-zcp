import { describe, expect, it } from "vite-plus/test";
import fs from "fs";
import { validateArgusBundle } from "../../../scripts/release/build.mjs";

const readRepoFile = (relativePath) =>
  fs.readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");

describe("Deployment contracts", () => {
  it("requires one matching Argus runtime and mod.info version before a package build", () => {
    expect(
      validateArgusBundle(
        'local Argus = { VERSION = "1.0.0", PROTOCOL = 1 }',
        "id=Argus\nmodversion=1.0.0\n",
      ),
    ).toBe("1.0.0");
    expect(() =>
      validateArgusBundle('local Argus = { PROTOCOL = 1 }', "modversion=1.0.0\n"),
    ).toThrow("exactly one runtime and mod.info version");
    expect(() =>
      validateArgusBundle(
        'local Argus = { VERSION = "1.0.1" }',
        "modversion=1.0.0\n",
      ),
    ).toThrow("runtime and mod.info versions differ");
  });

  it("keeps local data and runtime secrets out of the Docker build context", () => {
    const dockerignore = readRepoFile(".dockerignore");

    for (const pattern of [
      ".plans/",
      "data/",
      "newdata/",
      "logs/",
      "**/.env.*",
      "**/paths.config.json",
      "**/*.secret",
      "**/*.token",
      "**/*.sqlite",
      "**/*.db",
    ]) {
      expect(dockerignore).toContain(pattern);
    }
  });

  it("keeps the managed stack's game data mounts and Docker control while game ports belong to game containers", () => {
    const compose = readRepoFile("docker-compose.yml");
    expect(compose).toContain("pz-server:/pz-server");
    expect(compose).toContain("zomboid-data:/zomboid");
    expect(compose).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(compose).toContain('PANEL_MANAGED_GAMES: "true"');
    expect(compose).not.toContain("16261:16261/udp");
  });

  it("selects the image with BETTER_ZCP_VERSION and reports it to the panel in both compose files", () => {
    for (const file of ["docker-compose.yml", "docker-compose.panel-only.yml"]) {
      const compose = readRepoFile(file);
      expect(compose).toContain("name: better-zcp");
      expect(compose).toContain("image: ghcr.io/itsmeares/better-zcp:${BETTER_ZCP_VERSION:-latest}");
      expect(compose).toContain("PANEL_IMAGE_TAG: ${BETTER_ZCP_VERSION:-latest}");
    }
  });

  it("builds one image and publishes it only from a release tag after the release build", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");
    const dockerfile = readRepoFile("Dockerfile");

    expect(dockerfile).toContain("/home/steam/steamcmd");
    expect(workflow).toContain("type=semver,pattern={{version}}");
    expect(workflow).toContain("type=semver,pattern={{major}}.{{minor}}");
    expect(workflow.match(/flavor: latest=false/g) || []).toHaveLength(1);
    expect(workflow).toMatch(/image:\n\s+if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)\n\s+needs: build/);
    expect(workflow).toContain("needs: [build, image]");
    expect(workflow).toMatch(/latest:\n[\s\S]*needs: publish/);
    expect(workflow).toContain('if [[ "$version" != *-* ]]');
    expect(workflow).toContain('--tag "$image:stable"');
    expect(workflow).not.toContain("Dockerfile \\");
    expect(workflow).not.toContain("docker-compose.install.yml");
  });

  it("uploads the Linux archive from the release tree created by scripts/release/build.mjs", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");

    expect(workflow).toContain("archive_path: release/ZomboidControlPanel-linux.tar.gz");
    expect(workflow).toContain("path: ${{ matrix.archive_path }}");
  });

  it("uploads the Windows archive from the root path created by Compress-Archive", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");

    expect(workflow).toContain("archive_path: ZomboidControlPanel-windows.zip");
  });

  it("verifies all release versions before tag publication", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");
    const verifier = readRepoFile("scripts/verify-release-version.mjs");

    expect(workflow).toContain("node scripts/verify-release-version.mjs");
    expect(verifier).toContain("pnpm-lock.yaml");
    expect(verifier).toContain("validateArgusBundle(lua, modInfo)");
    expect(verifier).toContain("release-manifest.json client file inventory differs");
  });

  it("publishes prerelease tags as prereleases", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");

    expect(workflow).toContain('if [[ "$release_tag" == *-* ]]');
    expect(workflow).toContain("--prerelease");
  });

  it("smoke-tests each packaged executable before release publication", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");

    expect(workflow).toContain("name: Smoke-test packaged release");
    expect(workflow).toContain("run: node scripts/smoke-release.mjs");
  });

  it("smoke-tests the packaged Windows executable in Windows CI", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");

    expect(workflow).toContain("Build packaged Windows executable");
    expect(workflow).toContain("Smoke-test packaged Windows release");
    expect(workflow).toContain("run: node scripts/smoke-release.mjs");
  });

  it("checks the production browser bundle for server-only markers", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");
    const packageJson = readRepoFile("package.json");
    const releaseBuild = readRepoFile("scripts/release/build.mjs");

    expect(packageJson).toContain('"check:client-boundary"');
    expect(workflow).toContain("Check browser/server dependency boundary");
    expect(workflow).toContain("run: pnpm run check:client-boundary");
    expect(releaseBuild).toContain('"scripts/check-client-boundary.mjs"');
  });

  it("keeps the panel-only compose file free of PZ game ports", () => {
    const compose = readRepoFile("docker-compose.panel-only.yml");

    expect(compose).not.toContain("16261:16261/udp");
    expect(compose).not.toContain("16262:16262/udp");
  });
});
