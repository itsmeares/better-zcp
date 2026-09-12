import { describe, expect, it } from "vitest";
import fs from "fs";

const readRepoFile = (relativePath) =>
  fs.readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");

describe("Deployment contracts", () => {
  it("publishes both PZ UDP ports in the all-in-one Compose stack", () => {
    const compose = readRepoFile("infra/docker/all-in-one/docker-compose.yml");

    expect(compose).toContain('"16261:16261/udp"');
    expect(compose).toContain('"16262:16262/udp"');
  });

  it("pulls immutable release images before falling back to local builds", () => {
    const bootstrap = readRepoFile("infra/docker/all-in-one/bootstrap.sh");

    expect(bootstrap).toContain("ghcr.io/itsmeares/better-zcp:aio-$VERSION");
    expect(bootstrap).toContain("ghcr.io/itsmeares/better-zcp:updater-$VERSION");
    expect(bootstrap).toContain('docker pull "$published_image"');
    expect(bootstrap).toContain('docker build -t "$local_image"');
    expect(bootstrap).toContain("up -d --no-build");
    expect(bootstrap).toContain('if [ "$health" = "healthy" ]');
    expect(bootstrap).toContain("All-in-one installation is ready.");
  });

  it("publishes versioned panel and updater images from release tags", () => {
    const workflow = readRepoFile(".github/workflows/docker-aio-build.yml");

    expect(workflow).toMatch(/- [\"']v2\.\*[\"']/);
    expect(workflow).toContain("type=raw,value=updater");
    expect(workflow).toContain("type=semver,pattern={{version}},prefix=aio-");
    expect(workflow).toContain(
      "type=semver,pattern={{version}},prefix=updater-",
    );
    expect(workflow.match(/flavor: latest=false/g) || []).toHaveLength(2);
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
    expect(verifier).toContain("PanelBridge must contain exactly one");
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
