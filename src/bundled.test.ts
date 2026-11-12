import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import release from "../vendor/cua/release.json" with { type: "json" };
import { BundledDriver, bundledAsset } from "./bundled.ts";
import type { Exec } from "./driver.ts";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function fixture(platform = "darwin", arch: NodeJS.Architecture = "arm64") {
  const root = mkdtempSync(join(tmpdir(), "computer-use-test-"));
  roots.push(root);
  const manifest = structuredClone(release);
  const asset = bundledAsset(platform, arch, manifest)!;
  asset.sha256 = createHash("sha256").update("fake archive").digest("hex");
  mkdirSync(join(root, "vendor", "cua"), { recursive: true });
  const archive = join(root, "vendor", "cua", asset.archive);
  writeFileSync(archive, "fake archive");
  const exec = vi.fn<Exec>(async (_file, args) => {
    const binary = join(args[3]!, asset.directory, ...asset.binary.split("/"));
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, "fake executable, never run");
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const runtime = join(root, "runtime");
  return { bundled: new BundledDriver(root, runtime, platform, arch, exec, manifest), root, runtime, archive, exec };
}

describe("included Cua Driver", () => {
  it("selects universal macOS and architecture-specific Windows releases", () => {
    expect(bundledAsset("darwin", "arm64")).toEqual(bundledAsset("darwin", "x64"));
    expect(bundledAsset("win32", "x64")?.archive).toContain("windows-x86_64");
    expect(bundledAsset("win32", "arm64")?.archive).toContain("windows-arm64");
    expect(bundledAsset("win32", "ia32")).toBeNull();
    expect(bundledAsset("linux", "x64")).toBeNull();
  });

  it("unpacks once for concurrent setup requests, then reuses its private copy", async () => {
    const { bundled, exec } = fixture();
    expect(bundled.info("included")).toMatchObject({ includedAvailable: true, includedReady: false });
    const [a, b] = await Promise.all([bundled.prepare(), bundled.prepare()]);
    expect(a).toBe(b);
    expect(a).toContain("runtime/0.33.4/darwin-arm64/CuaDriver.app/");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(bundled.info("included").includedReady).toBe(true);
    await bundled.prepare();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("checks archives before executing an extractor", async () => {
    const { bundled, exec, archive } = fixture();
    writeFileSync(archive, "corrupted archive");
    await expect(bundled.prepare()).rejects.toThrow("failed its checksum");
    expect(exec).not.toHaveBeenCalled();
    expect(bundled.info("included").includedReady).toBe(false);
  });

  it("cleans failed extraction and allows retry without a partial installed copy", async () => {
    const { bundled, exec, runtime } = fixture();
    exec.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Extraction failed" });
    await expect(bundled.prepare()).rejects.toThrow("Extraction failed");
    expect(readdirSync(join(runtime, release.version))).toEqual([]);
    expect(bundled.info("included").includedReady).toBe(false);
    await bundled.prepare();
    expect(bundled.info("included").includedReady).toBe(true);
  });

  it("uses the Windows extractor and keeps sidecar layout together", async () => {
    const { bundled, exec } = fixture("win32", "x64");
    await bundled.prepare();
    expect(exec.mock.calls[0]?.[0]).toBe("tar.exe");
    expect(bundled.info("included").includedPath).toContain("win32-x64/cua-driver.exe");
  });
});
