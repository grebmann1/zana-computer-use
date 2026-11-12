import { describe, expect, it, vi } from "vitest";
import { CuaDriver, binaryCandidates, normalizeBinaryPath, parseDaemonStatus, parseScreenLocked, parseVersion, type Exec } from "./driver.ts";

const RUNNING = `Cua Driver daemon is running
  socket: /Users/me/Library/Caches/cua-driver/cua-driver.sock
  pid: 5420
  permission mode: standard (built_in_default)
`;

describe("parsers", () => {
  it("reads the daemon state from `cua-driver status`", () => {
    expect(parseDaemonStatus(RUNNING)).toEqual({ running: true, pid: 5420, permissionMode: "standard" });
    expect(parseDaemonStatus("Cua Driver daemon is not running")).toEqual({ running: false, pid: null, permissionMode: null });
  });

  it("reads the version", () => {
    expect(parseVersion("cua-driver 0.33.3\n")).toBe("0.33.3");
    expect(parseVersion("garbage")).toBeNull();
  });

  it("reads the console lock flag from ioreg", () => {
    const plist = (value: string) => `<dict><key>IOConsoleUsers</key><array><dict>
      <key>CGSSessionScreenIsLocked</key>
      <${value}/></dict></array></dict>`;
    expect(parseScreenLocked(plist("true"))).toBe(true);
    expect(parseScreenLocked(plist("false"))).toBe(false);
    expect(parseScreenLocked("<dict><key>IOConsoleUsers</key></dict>")).toBe(false);
    expect(parseScreenLocked("")).toBeNull();
  });
});

function recordingExec(reply: (file: string, args: string[]) => { exitCode?: number; stdout?: string; stderr?: string }) {
  const runs: Array<{ file: string; args: string[] }> = [];
  const exec: Exec = async (file, args) => {
    runs.push({ file, args });
    const out = reply(file, args);
    return { exitCode: out.exitCode ?? 0, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  };
  return { exec, runs };
}

describe("CuaDriver", () => {
  it("prefers the configured binary, then the standard install locations", () => {
    const present = new Set(["/Applications/CuaDriver.app/Contents/MacOS/cua-driver", "/opt/custom/cua-driver"]);
    const exists = (path: string) => present.has(path);
    expect(new CuaDriver(() => "/opt/custom/cua-driver", undefined, exists).binary()).toBe("/opt/custom/cua-driver");
    expect(new CuaDriver(() => undefined, undefined, exists).binary()).toBe("/Applications/CuaDriver.app/Contents/MacOS/cua-driver");
    expect(new CuaDriver(() => undefined, undefined, () => false).binary()).toBeNull();
  });

  it("passes tool arguments as one JSON argument and parses JSON replies", async () => {
    const { exec, runs } = recordingExec(() => ({ stdout: '{"status":"ok","apps":[]}\n' }));
    const driver = new CuaDriver(() => "/bin/cua", exec, () => true);
    const result = await driver.call("list_apps", { session: "zcc-x" });
    expect(runs[0]).toEqual({ file: "/bin/cua", args: ["call", "list_apps", '{"session":"zcc-x"}'] });
    expect(result).toEqual({ ok: true, exitCode: 0, json: { status: "ok", apps: [] }, text: "" });
  });

  it("reports a refusal as a failed call with its JSON body", async () => {
    const refused = '{"status":"refused","refusal":{"code":"stale_token","message":"Refresh"}}';
    const { exec } = recordingExec(() => ({ exitCode: 1, stdout: refused }));
    const result = await new CuaDriver(() => "/bin/cua", exec, () => true).call("click", {});
    expect(result.ok).toBe(false);
    expect(result.json?.refusal).toEqual({ code: "stale_token", message: "Refresh" });
  });

  it("reads permissions and telemetry from their JSON status", async () => {
    const { exec } = recordingExec((_file, args) =>
      args[0] === "permissions"
        ? { stdout: '{"accessibility":true,"screen_recording":false}' }
        : { stdout: '{"enabled":false,"source":"user"}' },
    );
    const driver = new CuaDriver(() => "/bin/cua", exec, () => true);
    expect(await driver.permissions()).toEqual({ accessibility: true, screenRecording: false });
    expect(await driver.telemetry()).toBe(false);
  });

  it("starts the daemon through LaunchServices and never in unrestricted mode", async () => {
    const { exec, runs } = recordingExec((file) => (file === "/usr/bin/open" ? {} : { stdout: RUNNING }));
    const driver = new CuaDriver(() => "/Users/me/Applications/CuaDriver.app", exec, () => true, { platform: "darwin" });
    await driver.start({ permissionMode: "bounded", capabilityManifest: "/etc/cua.yaml" });
    expect(runs[0]).toEqual({
      file: "/usr/bin/open",
      args: ["-n", "-g", "-a", "/Users/me/Applications/CuaDriver.app", "--args", "serve", "--permission-mode", "bounded", "--capability-manifest", "/etc/cua.yaml", "--approve-capability-manifest"],
    });
    await driver.start({ permissionMode: "standard" });
    expect(runs.find((run, index) => index > 0 && run.file === "/usr/bin/open")?.args).toEqual(["-n", "-g", "-a", "/Users/me/Applications/CuaDriver.app", "--args", "serve", "--permission-mode", "standard"]);
    expect(runs.flatMap((run) => run.args)).not.toContain("unrestricted");
  });

  it("honors a selected included or custom copy without falling back", () => {
    let source: "automatic" | "included" | "custom" = "included";
    let path: string | undefined;
    const included = "/private/CuaDriver.app/Contents/MacOS/cua-driver";
    const present = new Set([included, "/Applications/CuaDriver.app/Contents/MacOS/cua-driver"]);
    const driver = new CuaDriver(() => path, undefined, (p) => present.has(p), { source: () => source, includedPath: () => included, platform: "darwin" });
    expect(driver.binary()).toBe(included);
    present.delete(included);
    expect(driver.binary()).toBeNull();
    source = "custom";
    expect(driver.binary()).toBeNull();
    path = "/missing/cua-driver";
    expect(driver.binary()).toBeNull();
    source = "automatic";
    expect(driver.binary()).toBeNull(); // Legacy explicit overrides remain explicit.
    path = undefined;
    expect(driver.binary()).toBe("/Applications/CuaDriver.app/Contents/MacOS/cua-driver");
  });

  it("accepts macOS app bundles and finds the Windows installer location", () => {
    expect(normalizeBinaryPath('"~/Applications/CuaDriver.app"', "darwin", "/Users/me")).toBe("/Users/me/Applications/CuaDriver.app/Contents/MacOS/cua-driver");
    expect(binaryCandidates(undefined, "win32", "C:\\Users\\me", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })[0]).toBe("C:\\Users\\me\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe");
  });

  it("starts the selected Windows executable without macOS commands or permissions", async () => {
    const launch = vi.fn(async () => undefined);
    const { exec, runs } = recordingExec(() => ({ stdout: RUNNING }));
    const driver = new CuaDriver(() => "C:\\Cua\\cua-driver.exe", exec, () => true, { platform: "win32", launch });
    await driver.start({ permissionMode: "bounded", capabilityManifest: "C:\\Cua\\scope.yaml" });
    expect(launch).toHaveBeenCalledWith("C:\\Cua\\cua-driver.exe", ["serve", "--permission-mode", "bounded", "--capability-manifest", "C:\\Cua\\scope.yaml", "--approve-capability-manifest"]);
    expect(await driver.permissions()).toEqual({ accessibility: null, screenRecording: null });
    expect(await driver.screenLocked()).toBeNull();
    expect(runs.some((run) => run.file === "/usr/bin/open" || run.file === "/usr/sbin/ioreg" || run.args[0] === "permissions")).toBe(false);
  });

  it("never launches another macOS app for a custom bare binary", async () => {
    const { exec, runs } = recordingExec(() => ({}));
    const driver = new CuaDriver(() => "/custom/cua-driver", exec, () => true, { platform: "darwin" });
    await expect(driver.start({ permissionMode: "standard" })).rejects.toThrow("select CuaDriver.app");
    expect(runs).toEqual([]);
  });

  it("refuses bounded mode without a manifest", async () => {
    const { exec, runs } = recordingExec(() => ({}));
    await expect(new CuaDriver(() => "/bin/cua", exec, () => true).start({ permissionMode: "bounded" })).rejects.toThrow(
      "bounded mode needs a capability manifest path",
    );
    expect(runs).toEqual([]);
  });
});
