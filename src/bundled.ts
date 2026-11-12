import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import release from "../vendor/cua/release.json" with { type: "json" };
import { defaultExec, type Exec } from "./driver.ts";

export type DriverSource = "automatic" | "included" | "custom";
export interface SetupInfo {
  platform: string;
  source: DriverSource;
  includedVersion: string;
  includedAvailable: boolean;
  includedReady: boolean;
  includedPath: string | null;
  releaseUrl: string;
}

export function bundledAsset(platform: string, arch: string, manifest = release) {
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) return manifest.assets.darwin;
  if (platform === "win32" && arch === "x64") return manifest.assets["win32-x64"];
  if (platform === "win32" && arch === "arm64") return manifest.assets["win32-arm64"];
  return null;
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Unpack a pinned, checksummed release into a private directory, without replacing a user's installation. */
export class BundledDriver {
  private preparing: Promise<string> | null = null;
  constructor(
    private readonly packageRoot: string,
    private readonly runtimeRoot = join(homedir(), ".cua-driver", "computer-use-plugin"),
    private readonly platform = process.platform as string,
    private readonly arch = process.arch,
    private readonly exec: Exec = defaultExec,
    private readonly manifest = release,
  ) {}

  private asset() { return bundledAsset(this.platform, this.arch, this.manifest); }
  private target() { return join(this.runtimeRoot, this.manifest.version, `${this.platform}-${this.arch}`); }

  info(source: DriverSource): SetupInfo {
    const asset = this.asset();
    const includedPath = asset ? join(this.target(), ...asset.binary.split("/")) : null;
    return {
      platform: this.platform, source, includedVersion: this.manifest.version, releaseUrl: this.manifest.releaseUrl,
      includedAvailable: Boolean(asset && existsSync(join(this.packageRoot, "vendor", "cua", asset.archive))),
      includedReady: Boolean(includedPath && existsSync(includedPath)), includedPath,
    };
  }

  prepare(): Promise<string> {
    if (!this.preparing) this.preparing = this.unpack().finally(() => { this.preparing = null; });
    return this.preparing;
  }

  private async unpack(): Promise<string> {
    const info = this.info("included");
    if (!info.includedAvailable || !info.includedPath) throw new Error("The included driver is unavailable for this platform. Choose an existing Cua Driver path.");
    if (info.includedReady) return info.includedPath;
    const asset = this.asset()!;
    const archive = join(this.packageRoot, "vendor", "cua", asset.archive);
    if (await sha256(archive) !== asset.sha256) throw new Error("The included Cua Driver archive failed its checksum. Reinstall the plugin.");
    await mkdir(join(this.runtimeRoot, this.manifest.version), { recursive: true });
    const staging = await mkdtemp(join(this.runtimeRoot, this.manifest.version, "unpack-"));
    try {
      const tar = this.platform === "darwin" ? "/usr/bin/tar" : "tar.exe";
      const result = await this.exec(tar, ["-xf", archive, "-C", staging], { timeoutMs: 120_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr || "Could not unpack Cua Driver. On Windows, tar.exe must be available.");
      const extracted = join(staging, asset.directory);
      if (!existsSync(join(extracted, ...asset.binary.split("/")))) throw new Error("The included Cua Driver executable is missing from the archive.");
      try { await rename(extracted, this.target()); }
      catch (error) { if (!this.info("included").includedReady) throw error; }
      return info.includedPath;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
