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

  it("keeps the panel's game data mounts and Docker control while game ports belong to game containers", () => {
    const compose = readRepoFile("infra/docker/all-in-one/docker-compose.yml");
    expect(compose).toContain("pz-server:/pz-server");
    expect(compose).toContain("zomboid-data:/zomboid");
    expect(compose).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(compose).not.toContain('"16261:16261/udp"');
  });

  it("pulls immutable release images before falling back to local builds", () => {
    const bootstrap = readRepoFile("infra/docker/all-in-one/bootstrap.sh");

    expect(bootstrap).toContain("ghcr.io/itsmeares/better-zcp:aio-$VERSION");
    expect(bootstrap).toContain('docker pull "$published_image"');
    expect(bootstrap).toContain('docker build -t "$local_image"');
    expect(bootstrap).toContain("up -d --no-deps --no-build --remove-orphans panel");
    expect(bootstrap).toContain('if [ "$health" = "healthy" ]');
    expect(bootstrap).toContain("Panel installation is ready.");
    expect(bootstrap).toContain("Save and stop it from the panel before splitting the containers.");
    expect(bootstrap).toContain("--remove-orphans");
  });

  it("publishes a versioned panel image from release tags", () => {
    const workflow = readRepoFile(".github/workflows/docker-aio-build.yml");

    expect(workflow).toMatch(/- [\"']v\*[\"']/);
    expect(workflow).toContain("type=semver,pattern={{version}},prefix=aio-");
    expect(workflow.match(/flavor: latest=false/g) || []).toHaveLength(1);
    expect(workflow).not.toContain("updater/Dockerfile");
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
    expect(verifier).toContain(
      "Game integration must contain exactly one runtime and mod.info version",
    );
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

  it("keeps the generic installer free of PZ game ports", () => {
    const compose = readRepoFile("docker-compose.install.yml");

    expect(compose).not.toContain("16261:16261/udp");
    expect(compose).not.toContain("16262:16262/udp");
  });
});
