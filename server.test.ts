import { createFakePluginHost } from "@zana-ai/zcc-plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_TIMEOUT_MS } from "./src/controller.ts";
import { APPROVAL_RENDERER_ID, createPlugin } from "./server.ts";
import { FakeDriver } from "./test/fake-driver.ts";
import { BundledDriver } from "./src/bundled.ts";

type ToolResult = { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
type Harness = ReturnType<typeof createFakePluginHost>["harness"] & {
  callAgentTool(name: string, input: unknown, ctx?: { threadId?: string }): Promise<unknown>;
  emitThreadEvent(name: string, payload: unknown): Promise<{ errors: unknown[] }>;
  submitInteraction(value: unknown): void;
  cancelInteraction(): void;
  sdk: { stub(path: string, impl: (...args: never[]) => unknown): void };
  published: Array<{ event: string; payload: unknown }>;
  needsConfiguration: string | null;
};

let active: Harness | null = null;
afterEach(async () => {
  await active?.dispose();
  active = null;
});

async function load(driver = new FakeDriver(), bundled?: BundledDriver) {
  const { zcc, harness } = createFakePluginHost({ pluginId: "cua-driver-test" });
  const host = harness as unknown as Harness;
  host.sdk.stub("threads.get", (({ threadId }: { threadId: string }) => ({ title: `Thread ${threadId}` })) as never);
  const requests: Array<{ threadId: string; rendererId: string; payload: Record<string, unknown> }> = [];
  const ui = zcc.ui as unknown as { requestInput: (request: never) => Promise<unknown> };
  const requestInput = ui.requestInput.bind(ui);
  ui.requestInput = (request: never) => {
    requests.push(request);
    return requestInput(request);
  };
  await createPlugin(() => driver, bundled)(zcc);
  active = host;
  const call = async (threadId: string, tool: string, args?: Record<string, unknown>) => {
    const result = (await host.callAgentTool("cua_driver", { tool, arguments: args }, { threadId })) as ToolResult;
    return { ...result, body: JSON.parse(result.content[0]!.text!) as Record<string, any> };
  };
  return { host, driver, requests, call };
}

describe("Cua Driver plugin", () => {
  it("prepares the included copy without changing the user's selected source", async () => {
    const bundled = new BundledDriver("/fake-plugin");
    const prepare = vi.spyOn(bundled, "prepare").mockResolvedValue("/fake-included/cua-driver");
    const info = vi.spyOn(bundled, "info").mockImplementation((source) => ({
      platform: "darwin", source, includedVersion: "0.33.4", includedAvailable: true,
      includedReady: true, includedPath: "/fake-included/cua-driver", releaseUrl: "https://example.test/release",
    }));
    const { host } = await load(new FakeDriver(), bundled);
    host.setSettings({ driverSource: "Custom path", binaryPath: "/my/CuaDriver.app" });
    expect(await host.callRpc("prepareIncluded")).toMatchObject({ output: expect.stringContaining("/fake-included/cua-driver") });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await host.callRpc("status")).toMatchObject({
      settings: { driverSource: "custom", binaryPath: "/my/CuaDriver.app" },
      setup: { source: "custom", includedVersion: "0.33.4", includedReady: true },
    });
    expect(info).toHaveBeenCalledWith("custom");
    host.setSettings({ driverSource: "Included with plugin" });
    expect(await host.callRpc("status")).toMatchObject({ settings: { driverSource: "included" } });
    prepare.mockRejectedValueOnce(new Error("Archive checksum failed"));
    await expect(host.callRpc("prepareIncluded")).rejects.toThrow("Archive checksum failed");
  });

  it("registers agent tools, instructions and the CLI", async () => {
    const { host } = await load();
    expect(host.agentTools.map((tool) => tool.name)).toEqual(["cua_driver", "cua_driver_describe", "cua_driver_release"]);
    expect(host.extraInstructions.join("\n")).toContain("Do not run the `cua-driver` shell CLI");
    expect(host.cli?.name).toBe("cua-driver");
  });

  it("asks for configuration when Cua Driver is not installed and refuses calls", async () => {
    const driver = new FakeDriver();
    driver.installed = false;
    const { host, call } = await load(driver);
    expect(host.needsConfiguration).toContain("use the included driver or choose an existing path");
    const result = await call("t1", "list_apps");
    expect(result.isError).toBe(true);
    expect(result.body.refusal.code).toBe("driver_not_installed");
    expect(driver.calls).toEqual([]);
  });

  it("runs discovery without taking the desktop", async () => {
    const { driver, call } = await load();
    const result = await call("t1", "list_apps");
    expect(result.body).toMatchObject({ status: "ok", summary: "list_apps done" });
    expect(driver.toolCalls("list_apps")[0]!.args).toEqual({ session: "zcc-t1" });
    expect((await call("t2", "list_apps")).body.status).toBe("ok");
  });

  it("serializes desktop control: the second thread gets desktop_busy until the first goes idle", async () => {
    const { host, driver, call } = await load();
    const first = await call("thread-a", "get_window_state", { pid: 1, window_id: 2 });
    expect(first.body.status).toBe("ok");
    expect(first.content[1]).toMatchObject({ type: "image", data: Buffer.from("png-bytes").toString("base64") });
    const sent = driver.toolCalls("get_window_state")[0]!;
    expect(sent.args).toEqual({ pid: 1, window_id: 2, session: "zcc-threada" });
    expect(String(sent.options.screenshotOutFile)).toMatch(/zcc-cua-driver\/zcc-threada\/\d+-1-get_window_state\.png$/);
    expect(first.body.screenshot_file_path).toBe(sent.options.screenshotOutFile);

    const busy = await call("thread-b", "click", { pid: 1, window_id: 2, element_token: "s1:1" });
    expect(busy.isError).toBe(true);
    expect(busy.body.refusal.code).toBe("desktop_busy");
    expect(busy.body.refusal.message).toContain("Thread thread-a");
    expect(driver.toolCalls("click")).toEqual([]);

    // Another thread finishing must not free a lease it does not hold.
    await host.emitThreadEvent("thread.idle", { thread: { id: "thread-b" } });
    expect((await call("thread-b", "click", {})).body.refusal.code).toBe("desktop_busy");

    await host.emitThreadEvent("thread.idle", { thread: { id: "thread-a" } });
    expect(driver.toolCalls("end_session").at(-1)?.args).toEqual({ session: "zcc-threada" });
    expect((await call("thread-b", "click", { pid: 1, window_id: 2, element_token: "s1:1" })).body.status).toBe("ok");
  });

  it("refuses desktop work while the screen is locked", async () => {
    const driver = new FakeDriver();
    driver.locked = true;
    const { call } = await load(driver);
    expect((await call("t1", "get_window_state", { pid: 1, window_id: 2 })).body.refusal.code).toBe("screen_locked");
    expect(driver.toolCalls("get_window_state")).toEqual([]);
    expect((await call("t1", "list_apps")).body.status).toBe("ok");
  });

  it("asks the user before foreground actions and remembers allow-for-thread", async () => {
    const { host, driver, requests, call } = await load();
    const pending = call("t1", "bring_to_front", { pid: 7 });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ threadId: "t1", rendererId: APPROVAL_RENDERER_ID, payload: { tool: "bring_to_front", keys: ["foreground"] } });
    expect(driver.toolCalls("bring_to_front")).toEqual([]);
    host.submitInteraction({ decision: "allow-thread" });
    expect((await pending).body.status).toBe("ok");

    expect((await call("t1", "type_text", { delivery_mode: "foreground", text: "x" })).body.status).toBe("ok");
    expect(requests).toHaveLength(1);
  });

  it("does not run an action the user denied or dismissed", async () => {
    const { host, driver, requests, call } = await load();
    const denied = call("t1", "get_desktop_state");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    host.submitInteraction({ decision: "deny" });
    expect((await denied).body.refusal.code).toBe("user_denied");

    const dismissed = call("t1", "kill_app", { pid: 9 });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    host.cancelInteraction();
    expect((await dismissed).body.refusal.code).toBe("user_denied");
    expect(driver.calls.map((entry) => entry.tool)).not.toContain("kill_app");
    expect(driver.calls.map((entry) => entry.tool)).not.toContain("get_desktop_state");
  });

  it("starts a stopped daemon in the configured mode before the first call", async () => {
    const driver = new FakeDriver();
    driver.daemonState = { running: false, pid: null, permissionMode: null };
    const { call } = await load(driver);
    expect((await call("t1", "list_apps")).body.status).toBe("ok");
    expect(driver.starts).toEqual([{ permissionMode: "standard", capabilityManifest: undefined }]);
  });

  it("rejects tools the installed driver does not have", async () => {
    const { driver, call } = await load();
    expect((await call("t1", "format_disk")).body.refusal.code).toBe("unknown_tool");
    expect((await call("t1", "../etc")).body.refusal.code).toBe("invalid_tool");
    expect(driver.calls).toEqual([]);
  });

  it("describes tools with their lease requirement", async () => {
    const { host } = await load();
    const result = (await host.callAgentTool("cua_driver_describe", {})) as ToolResult;
    const body = JSON.parse(result.content[0]!.text!);
    expect(body.tools).toContainEqual({ name: "list_apps", summary: "List apps.", needs_lease: false });
    expect(body.tools).toContainEqual({ name: "click", summary: "click.", needs_lease: true });
  });

  it("lets the agent hand the desktop back", async () => {
    const { host, call } = await load();
    await call("t1", "click", {});
    expect(await host.callAgentTool("cua_driver_release", {}, { threadId: "t2" })).toBe('{"released":false}');
    expect(await host.callAgentTool("cua_driver_release", {}, { threadId: "t1" })).toBe('{"released":true}');
  });

  it("serves status, thread state and the latest screenshot to the UI", async () => {
    const { host, call } = await load();
    await call("t1", "get_window_state", { pid: 1, window_id: 2 });
    const overview = (await host.callRpc("status")) as { status: { state: string; lease: { threadId: string } } };
    expect(overview.status).toMatchObject({ state: "busy", lease: { threadId: "t1" } });
    const thread = (await host.callRpc("thread", { threadId: "t1" })) as { holdsLease: boolean; screenshot: { tool: string } };
    expect(thread).toMatchObject({ holdsLease: true, screenshot: { tool: "get_window_state" } });
    const shot = (await host.callRpc("screenshot", { threadId: "t1" })) as { dataUrl: string };
    expect(shot.dataUrl).toBe(`data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`);
    await expect(host.callRpc("thread", {})).rejects.toThrow("threadId is required");
    expect(host.published.map((signal) => signal.event)).toEqual(expect.arrayContaining(["cua.status", "cua.activity"]));
  });

  it("reports status and releases the lease from the CLI", async () => {
    const { host, call } = await load();
    await call("t1", "click", {});
    const status = await host.runCli(["status", "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({ state: "busy", version: "0.33.3", telemetry: true });
    expect((await host.runCli(["status"])).stdout).toContain("lease:          Thread t1 (t1)");
    expect((await host.runCli(["release"])).stdout).toBe("released lease held by Thread t1\n");
    expect((await host.runCli(["release"])).stdout).toBe("lease was free\n");
    expect((await host.runCli(["bogus"])).exitCode).toBe(2);
  });

  it("refuses calls while the daemon runs in a different or unrestricted mode", async () => {
    const driver = new FakeDriver();
    driver.daemonState = { running: true, pid: 1, permissionMode: "unrestricted" };
    const { host, call } = await load(driver);
    const status = JSON.parse((await host.runCli(["status", "--json"])).stdout);
    expect(status.warnings).toEqual([
      "The daemon runs in unrestricted mode. This plugin never starts it that way; restart it from here. Agent calls are refused until then.",
    ]);
    expect((await call("t1", "list_apps")).body.refusal.code).toBe("daemon_mode_mismatch");
    driver.daemonState = { running: true, pid: 1, permissionMode: "bounded" };
    expect((await call("t1", "list_apps")).body.refusal.message).toContain("runs in bounded mode but the plugin is set to standard");
    expect(driver.calls).toEqual([]);
  });

  it("refuses agent-chosen output paths and always uses its own screenshot file", async () => {
    const { driver, call } = await load();
    for (const name of ["screenshot_out_file", "debug_image_out"]) {
      const result = await call("t1", "get_window_state", { pid: 1, window_id: 2, [name]: "/Users/me/.zshrc" });
      expect(result.body.refusal.code).toBe("argument_not_allowed");
    }
    expect((await call("t1", "get_window_state", { pid: 1, window_id: 2, include_screenshot: false })).content).toHaveLength(1);
    expect(driver.toolCalls("get_window_state")[0]!.options.screenshotOutFile).toBeUndefined();
  });

  it("saves zoom crops as files and drops inline base64", async () => {
    const driver = new FakeDriver();
    const respond = driver.respond;
    driver.respond = (tool, args, options) => {
      const result = respond(tool, args, options) as { json: Record<string, unknown> };
      return { ...result, json: { ...result.json, screenshot_png_b64: "QUJD", screenshot_mime_type: "image/jpeg" } } as never;
    };
    const { call } = await load(driver);
    const result = await call("t1", "zoom", { window_id: 2, x1: 0, y1: 0, x2: 10, y2: 10 });
    expect(driver.toolCalls("zoom")[0]!.options.screenshotOutFile).toMatch(/-zoom\.jpg$/);
    expect(result.body.screenshot_png_b64).toBeUndefined();
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  });

  it("marks failed driver exits as errors even when the JSON has no status", async () => {
    const driver = new FakeDriver();
    const respond = driver.respond;
    driver.respond = (tool, args, options) => tool === "click"
      ? { ok: false, exitCode: 1, json: { message: "boom" }, text: "" }
      : respond(tool, args, options);
    const { call } = await load(driver);
    const result = await call("t1", "click", {});
    expect(result.isError).toBe(true);
    expect(result.body).toEqual({ message: "boom", status: "error" });
  });

  it("does not act if the user takes the desktop back while an approval is pending", async () => {
    const { host, driver, requests, call } = await load();
    const pending = call("t1", "bring_to_front", { pid: 7 });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(await host.callRpc("release", { threadId: "t2" })).toEqual({ released: null });
    expect(await host.callRpc("release", { threadId: "t1" })).toMatchObject({ released: { threadId: "t1" } });
    host.submitInteraction({ decision: "allow-once" });
    expect((await pending).body.refusal.code).toBe("lease_released");
    expect(driver.toolCalls("bring_to_front")).toEqual([]);
  });

  it("reopens the thread's session after a released lease ended it, and retries once", async () => {
    const driver = new FakeDriver();
    const respond = driver.respond;
    const ended = new Set(["zcc-t1"]);
    driver.respond = (tool, args, options) => {
      if (tool === "start_session") ended.delete(String(args.session));
      else if (ended.has(String(args.session))) {
        return { ok: false, exitCode: 1, json: null, text: `session has ended; tool call '${tool}' was rejected. Call start_session with session '${args.session}' to start it again, or use a new session label.` };
      }
      return respond(tool, args, options);
    };
    const { call } = await load(driver);
    expect((await call("t1", "click", { pid: 1 })).body.status).toBe("ok");
    expect(driver.calls.map((entry) => entry.tool)).toEqual([
      "set_agent_cursor_enabled", "click", "start_session",
      "set_agent_cursor_enabled", "set_agent_cursor_motion", "click",
    ]);

    // A label the agent chose is never reopened behind its back.
    ended.add("mine");
    expect((await call("t1", "click", { session: "mine" })).body.status).toBe("error");
    expect(driver.toolCalls("start_session")).toHaveLength(1);
  });

  it("gives up on an unanswered approval before the host aborts the tool call", async () => {
    const { host, driver, requests, call } = await load();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = call("t1", "bring_to_front", { pid: 7 });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
      expect((await pending).body.refusal.code).toBe("approval_timeout");
      host.submitInteraction({ decision: "allow-thread" });
      await vi.advanceTimersByTimeAsync(10);
      expect(driver.toolCalls("bring_to_front")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the daemon once for concurrent first calls", async () => {
    const driver = new FakeDriver();
    driver.daemonState = { running: false, pid: null, permissionMode: null };
    const { call } = await load(driver);
    const results = await Promise.all([call("t1", "list_apps"), call("t2", "list_apps"), call("t3", "list_apps")]);
    expect(results.map((result) => result.body.status)).toEqual(["ok", "ok", "ok"]);
    expect(driver.starts).toHaveLength(1);
  });

  it("backs off after the tool list cannot be read", async () => {
    const driver = new FakeDriver();
    let lists = 0;
    driver.listTools = async () => {
      lists++;
      throw new Error("mcp exited");
    };
    const { call } = await load(driver);
    expect((await call("t1", "list_apps")).body.status).toBe("ok");
    expect((await call("t1", "list_apps")).body.status).toBe("ok");
    expect(lists).toBe(1);
  });
});
