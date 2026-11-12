import { describe, expect, it } from "vitest";
import { Controller, DEFAULT_SETTINGS } from "./controller.ts";
import { FakeDriver } from "../test/fake-driver.ts";

function setup() {
  const driver = new FakeDriver();
  let settings = { ...DEFAULT_SETTINGS };
  const controller = new Controller({
    driver, settings: () => settings, screenshotDir: "/unused",
    threadTitle: async (id) => id, askApproval: async () => "deny", publish: () => {}, warn: () => {},
  });
  const original = driver.respond;
  driver.respond = (tool, args, options) => tool === "get_window_state" ? {
    ok: true, exitCode: 0, text: "", json: {
      pid: args.pid, window_id: args.window_id,
      elements: [{ element_index: 0, role: "AXWindow", frame: { x: -2560, y: 30, w: 2560, h: 1410 } }],
    },
  } : original(tool, args, options);
  const inspect = (thread = "a", windowId = 2) => controller.invoke(thread, "get_window_state", { pid: 1, window_id: windowId, include_screenshot: false });
  return { controller, driver, inspect, settings: (value: boolean) => { settings = { ...settings, showAgentCursor: value }; } };
}

describe("agent cursor defaults", () => {
  it("shows the cursor by default, disables idle fade, and seeds inspection from observed screen coordinates", async () => {
    const { driver, inspect } = setup();
    await inspect();
    expect(driver.calls.map((call) => call.tool)).toEqual([
      "set_agent_cursor_enabled", "set_agent_cursor_motion", "get_window_state", "move_cursor",
    ]);
    expect(driver.toolCalls("set_agent_cursor_enabled")[0]!.args).toEqual({ session: "zcc-a", enabled: true });
    expect(driver.toolCalls("set_agent_cursor_motion")[0]!.args).toEqual({ session: "zcc-a", idle_hide_ms: 0 });
    expect(driver.toolCalls("move_cursor")[0]!.args).toEqual({ session: "zcc-a", scope: "window", x: -1280, y: 735 });
    await inspect();
    expect(driver.toolCalls("move_cursor")).toHaveLength(1); // Verification preserves the last click position.
    await inspect("a", 3);
    expect(driver.toolCalls("move_cursor")).toHaveLength(2);
    expect(driver.toolCalls("set_agent_cursor_enabled")).toHaveLength(1);
  });

  it("never configures the cursor for discovery, a busy desktop or a denied action", async () => {
    const { controller, driver, inspect } = setup();
    await controller.invoke("a", "list_apps");
    expect(driver.calls.map((call) => call.tool)).toEqual(["list_apps"]);
    await controller.invoke("a", "bring_to_front", { pid: 1 });
    expect(driver.toolCalls("set_agent_cursor_enabled")).toEqual([]);
    await inspect();
    const count = driver.calls.length;
    expect(await inspect("b")).toMatchObject({ refusal: { code: "desktop_busy" } });
    expect(driver.calls).toHaveLength(count);
  });

  it("honors an opt-out and applies preference changes on the next action", async () => {
    const { driver, inspect, settings } = setup();
    settings(false);
    await inspect();
    expect(driver.toolCalls("set_agent_cursor_enabled")[0]!.args.enabled).toBe(false);
    expect(driver.toolCalls("move_cursor")).toEqual([]);
    expect(driver.toolCalls("set_agent_cursor_motion")).toEqual([]);
    settings(true);
    await inspect();
    expect(driver.toolCalls("set_agent_cursor_enabled").at(-1)!.args.enabled).toBe(true);
    expect(driver.toolCalls("move_cursor")).toHaveLength(1);
  });

  it("removes the session on release and reapplies cursor defaults to the next holder", async () => {
    const { controller, driver, inspect } = setup();
    await inspect();
    await controller.releaseLease("Done", "a");
    expect(driver.toolCalls("end_session")[0]!.args).toEqual({ session: "zcc-a" });
    await inspect("b");
    expect(driver.toolCalls("set_agent_cursor_enabled").at(-1)!.args.session).toBe("zcc-b");
    expect(driver.toolCalls("move_cursor").at(-1)!.args.session).toBe("zcc-b");
  });

  it("does not position an overlay from missing, invalid or mismatched window geometry", async () => {
    const { driver, inspect } = setup();
    for (const json of [
      { pid: 1, window_id: 999, window_bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { pid: 1, window_id: 2 },
      { pid: 1, window_id: 2, window_bounds: { x: 0, y: 0, width: -1, height: 100 } },
    ]) {
      driver.respond = () => ({ ok: true, exitCode: 0, text: "", json });
      await inspect();
    }
    expect(driver.toolCalls("move_cursor")).toEqual([]);
  });

  it("reports an unavailable cursor without turning a successful inspection into a failure", async () => {
    const { driver, inspect } = setup();
    const respond = driver.respond;
    driver.respond = (tool, args, options) => tool === "set_agent_cursor_enabled"
      ? { ok: false, exitCode: 1, json: null, text: "Overlay unavailable" }
      : respond(tool, args, options);
    expect(await inspect()).toMatchObject({ pid: 1, cua_cursor_warning: expect.stringContaining("Overlay unavailable") });
    expect(driver.toolCalls("move_cursor")).toEqual([]);
  });

  it("does not act after the user releases the desktop during cursor setup", async () => {
    const { controller, driver, inspect } = setup();
    const respond = driver.respond;
    driver.respond = async (tool, args, options) => {
      if (tool === "set_agent_cursor_enabled") await controller.releaseLease("User took it back", "a");
      return respond(tool, args, options);
    };
    expect(await inspect()).toMatchObject({ refusal: { code: "lease_released" } });
    expect(driver.toolCalls("set_agent_cursor_motion")).toEqual([]);
    expect(driver.toolCalls("get_window_state")).toEqual([]);
    expect(driver.toolCalls("move_cursor")).toEqual([]);
  });
});
