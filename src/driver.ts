import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import type { DriverSource } from "./bundled.ts";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<ExecResult>;

export interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  permissionMode: string | null;
}

export interface Permissions {
  accessibility: boolean | null;
  screenRecording: boolean | null;
}

export interface CallResult {
  ok: boolean;
  exitCode: number;
  /** Parsed stdout when it is JSON, otherwise null. */
  json: Record<string, unknown> | null;
  /** Raw output when it is not JSON (plain-text tools or failures). */
  text: string;
}

export interface CallOptions {
  screenshotOutFile?: string;
}

export interface ServeOptions {
  permissionMode: "standard" | "bounded";
  capabilityManifest?: string;
}

/** Everything the plugin needs from the installed Cua Driver. */
export interface DriverApi {
  binary(): string | null;
  version(): Promise<string | null>;
  daemon(): Promise<DaemonStatus>;
  permissions(): Promise<Permissions>;
  telemetry(): Promise<boolean | null>;
  setTelemetry(enabled: boolean): Promise<void>;
  screenLocked(): Promise<boolean | null>;
  listTools(): Promise<ToolSchema[]>;
  /** With `screenshotOutFile`, the CLI writes the response's first image there instead of inlining base64. */
  call(tool: string, args: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
  start(options: ServeOptions): Promise<void>;
  stop(): Promise<void>;
  grant(): Promise<string>;
}

export const defaultExec: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: options.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({
          exitCode: code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || (error && code !== 0 && !stdout ? error.message : ""),
        });
      },
    );
  });

export function normalizeBinaryPath(value: string, platform = process.platform as string, home = homedir()): string {
  let path = value.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (path.startsWith("~/") || path.startsWith("~\\")) path = join(home, path.slice(2));
  if (platform === "darwin" && path.endsWith(".app")) path = join(path, "Contents", "MacOS", "cua-driver");
  return path;
}

export function binaryCandidates(override?: string, platform = process.platform as string, home = homedir(), env = process.env): string[] {
  if (override?.trim()) return [normalizeBinaryPath(override, platform, home)];
  if (platform === "win32") return [
    win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe"),
    win32.join(home, ".local", "bin", "cua-driver.exe"),
  ];
  return [
    join(home, ".local/bin/cua-driver"),
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    join(home, "Applications/CuaDriver.app/Contents/MacOS/cua-driver"),
  ].filter(Boolean);
}

export type Launch = (file: string, args: string[]) => Promise<void>;
const defaultLaunch: Launch = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", reject);
  child.once("spawn", () => { child.unref(); resolve(); });
});

export interface DriverEnvironment {
  platform?: string;
  source?: () => DriverSource;
  includedPath?: () => string | null;
  launch?: Launch;
  resolvePath?: (path: string) => string;
}

export function parseDaemonStatus(text: string): DaemonStatus {
  const running = /daemon is running/i.test(text);
  const pid = /pid:\s*(\d+)/i.exec(text);
  const mode = /permission mode:\s*([a-z_-]+)/i.exec(text);
  return {
    running,
    pid: running && pid ? Number(pid[1]) : null,
    permissionMode: running && mode ? mode[1]! : null,
  };
}

export function parseVersion(text: string): string | null {
  return /cua-driver\s+(\d+\.\d+\.\d+[^\s]*)/.exec(text)?.[1] ?? null;
}

/** The console session's lock flag from `ioreg -n Root -d1 -a` (macOS). */
export function parseScreenLocked(plist: string): boolean | null {
  const match = /<key>CGSSessionScreenIsLocked<\/key>\s*<(true|false)\/>/.exec(plist);
  if (match) return match[1] === "true";
  return plist.includes("IOConsoleUsers") ? false : null;
}

function parseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export class CuaDriver implements DriverApi {
  constructor(
    private readonly binaryOverride: () => string | undefined,
    private readonly exec: Exec = defaultExec,
    private readonly exists: (path: string) => boolean = existsSync,
    private readonly environment: DriverEnvironment = {},
  ) {}

  binary(): string | null {
    const platform = this.environment.platform ?? process.platform;
    const source = this.environment.source?.() ?? "automatic";
    const override = this.binaryOverride();
    const included = this.environment.includedPath?.();
    const candidates = source === "included" ? (included ? [included] : [])
      : source === "custom" ? (override?.trim() ? [normalizeBinaryPath(override, platform)] : [])
      : [...binaryCandidates(override, platform), ...(!override?.trim() && included ? [included] : [])];
    return candidates.find((path) => this.exists(path)) ?? null;
  }

  private async run(args: string[], timeoutMs?: number): Promise<ExecResult> {
    const bin = this.binary();
    if (!bin) return { exitCode: 127, stdout: "", stderr: "cua-driver is not installed" };
    return this.exec(bin, args, { timeoutMs });
  }

  async version() {
    const result = await this.run(["--version"], 10_000);
    return result.exitCode === 0 ? parseVersion(result.stdout) : null;
  }

  async daemon() {
    const result = await this.run(["status"], 10_000);
    return parseDaemonStatus(`${result.stdout}\n${result.stderr}`);
  }

  async permissions(): Promise<Permissions> {
    if ((this.environment.platform ?? process.platform) !== "darwin") return { accessibility: null, screenRecording: null };
    const json = parseJson((await this.run(["permissions", "status", "--json"], 10_000)).stdout);
    const read = (key: string) => (typeof json?.[key] === "boolean" ? (json[key] as boolean) : null);
    return { accessibility: read("accessibility"), screenRecording: read("screen_recording") };
  }

  async telemetry() {
    const json = parseJson((await this.run(["telemetry", "status", "--json"], 10_000)).stdout);
    return typeof json?.enabled === "boolean" ? json.enabled : null;
  }

  async setTelemetry(enabled: boolean) {
    const result = await this.run(["telemetry", enabled ? "enable" : "disable"], 10_000);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "telemetry change failed");
  }

  async screenLocked() {
    if ((this.environment.platform ?? process.platform) !== "darwin") return null;
    const result = await this.exec("/usr/sbin/ioreg", ["-n", "Root", "-d1", "-a"], { timeoutMs: 5_000 });
    return result.exitCode === 0 ? parseScreenLocked(result.stdout) : null;
  }

  async call(tool: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallResult> {
    const argv = ["call", tool, JSON.stringify(args)];
    if (options.screenshotOutFile) argv.push("--screenshot-out-file", options.screenshotOutFile);
    const result = await this.run(argv, 120_000);
    const json = parseJson(result.stdout);
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      json,
      text: json ? "" : [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
    };
  }

  async start(options: ServeOptions) {
    const serve = ["serve", "--permission-mode", options.permissionMode];
    if (options.permissionMode === "bounded") {
      if (!options.capabilityManifest) throw new Error("bounded mode needs a capability manifest path");
      serve.push(
        "--capability-manifest",
        options.capabilityManifest,
        "--approve-capability-manifest",
      );
    }
    const platform = this.environment.platform ?? process.platform;
    const binary = this.binary();
    if (!binary) throw new Error("Select a Cua Driver installation first.");
    if (platform === "darwin") {
      const app = this.macApp(binary);
      if (!app) throw new Error("On macOS, select CuaDriver.app or its Contents/MacOS/cua-driver executable so permissions belong to the selected app.");
      // Launch the exact selected app through LaunchServices, preserving its TCC identity.
      const result = await this.exec("/usr/bin/open", ["-n", "-g", "-a", app, "--args", ...serve], { timeoutMs: 15_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr || "failed to launch CuaDriver");
    } else if (platform === "win32") {
      await (this.environment.launch ?? defaultLaunch)(binary, serve);
    } else {
      throw new Error("Computer Use setup currently supports macOS and Windows.");
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await this.daemon()).running) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("CuaDriver did not start within 10 seconds");
  }

  async stop() {
    const result = await this.run(["stop"], 15_000);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "Could not stop the daemon.");
  }

  private macApp(binary: string): string | null {
    let resolved = binary;
    try { resolved = (this.environment.resolvePath ?? realpathSync)(binary); } catch { /* Report a non-app path below. */ }
    return /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(resolved)?.[1] ?? null;
  }

  async grant() {
    if ((this.environment.platform ?? process.platform) !== "darwin") return "Windows does not need macOS Accessibility or Screen Recording grants. Use an unlocked interactive desktop with Zana and Cua Driver running as the same user.";
    // Upstream `permissions grant` always targets /Applications/CuaDriver.app.
    // A private/custom copy must be granted through its own first-launch gate and System Settings.
    const app = this.binary() ? this.macApp(this.binary()!) : null;
    if (app !== "/Applications/CuaDriver.app") {
      const result = await this.exec("/usr/bin/open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], { timeoutMs: 10_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr || "Could not open System Settings.");
      return `Enable Accessibility for ${app ?? "the selected CuaDriver.app"}, then enable Screen & System Audio Recording for the same app. Use the + button to add it if needed. Restart the daemon after granting both.`;
    }
    const result = await this.run(["permissions", "grant"], 120_000);
    return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  }

  /** Read every tool's input schema once through the stdio MCP server. */
  listTools(): Promise<ToolSchema[]> {
    const bin = this.binary();
    if (!bin) return Promise.reject(new Error("cua-driver is not installed"));
    return new Promise((resolve, reject) => {
      // Windows bare MCP owns a separate runtime; inspect the actual daemon's schemas instead.
      const argv = (this.environment.platform ?? process.platform) === "win32"
        ? ["mcp", "--socket", "\\\\.\\pipe\\cua-driver"] : ["mcp"];
      const child = spawn(bin, argv, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      let buffer = "";
      let settled = false;
      const finish = (error: Error | null, tools?: ToolSchema[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        if (error) reject(error);
        else resolve(tools ?? []);
      };
      const timer = setTimeout(() => finish(new Error("tools/list timed out")), 20_000);
      child.on("error", (error) => finish(error));
      child.on("exit", () => finish(new Error("cua-driver mcp exited before tools/list")));
      // Writes to a child that already exited raise EPIPE here instead of crashing the host.
      child.stdin.on("error", (error) => finish(error));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const message = parseJson(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message?.id === 2) {
            const tools = (message.result as { tools?: ToolSchema[] } | undefined)?.tools;
            finish(null, Array.isArray(tools) ? tools : []);
          }
        }
      });
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "zcc-cua-driver", version: "0.1.0" } },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    });
  }
}
