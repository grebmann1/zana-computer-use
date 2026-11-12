import { describe, expect, it } from "vitest";
import { approvalsFor, needsLease } from "./policy.ts";

const keys = (tool: string, args: Record<string, unknown> = {}) => approvalsFor(tool, args).map((approval) => approval.key);

describe("needsLease", () => {
  it("lets read-only discovery run without the desktop", () => {
    for (const tool of ["list_apps", "list_windows", "check_permissions", "get_screen_size"]) {
      expect(needsLease(tool)).toBe(false);
    }
  });

  it("requires the desktop for observation and input", () => {
    for (const tool of ["get_window_state", "click", "type_text", "launch_app", "zoom"]) {
      expect(needsLease(tool)).toBe(true);
    }
  });
});

describe("approvalsFor", () => {
  it("asks before whole-desktop input however the driver would read it", () => {
    expect(keys("click", { target: { kind: "desktop", display_id: "primary" } })).toEqual(["desktop"]);
    expect(keys("click", { scope: "desktop", x: 10, y: 10 })).toEqual(["desktop"]);
    expect(keys("start_session", { capture_scope: "desktop" })).toEqual(["desktop"]);
    expect(keys("escalate_session", { reason: "other" })).toEqual(["desktop"]);
  });

  it("asks before foreground delivery, including the dispatch alias and any casing", () => {
    expect(keys("type_text", { delivery_mode: "foreground" })).toEqual(["foreground"]);
    expect(keys("type_text", { dispatch: "foreground" })).toEqual(["foreground"]);
    expect(keys("click", { delivery_mode: " Foreground " })).toEqual(["foreground"]);
  });

  it("asks for sensitive tools and groups related ones under one key", () => {
    expect(keys("bring_to_front")).toEqual(["foreground"]);
    expect(keys("get_desktop_state")).toEqual(["desktop"]);
    expect(keys("clipboard_read")).toEqual(["clipboard"]);
    expect(keys("clipboard_write", { text: "x" })).toEqual(["clipboard"]);
    expect(keys("kill_app")).toEqual(["kill_app"]);
    expect(keys("page", { action: "execute_javascript", javascript: "1" })).toEqual(["page_script"]);
    expect(keys("page", { action: "get_text" })).toEqual([]);
  });

  it("collects every approval instead of stopping at the first", () => {
    expect(keys("get_desktop_state", { delivery_mode: "foreground" })).toEqual(["desktop", "foreground"]);
    expect(keys("click", { target: { kind: "desktop" }, dispatch: "foreground" })).toEqual(["desktop", "foreground"]);
  });

  it("asks before reading or writing local paths, per exact path", () => {
    const recording = approvalsFor("start_recording", { output_dir: "~/Documents" });
    expect(recording).toEqual([{ key: 'paths:start_recording:["~/Documents"]', reason: "write a recording to ~/Documents" }]);
    expect(keys("browser_set_input_files", { files: ["/a", "/b"] })).toEqual(['paths:browser_set_input_files:["/a","/b"]']);
    expect(keys("browser_download", { destination_root: "/tmp/x" })).toEqual(['paths:browser_download:["/tmp/x"]']);
    expect(keys("clipboard_write", { image_path: "/p.png" })).toEqual(['paths:clipboard_write:["/p.png"]', "clipboard"]);
  });

  it("lets default background window actions through", () => {
    expect(keys("click", { pid: 1, window_id: 2, element_token: "s1:1" })).toEqual([]);
    expect(keys("type_text", { delivery_mode: "background" })).toEqual([]);
    expect(keys("click", { target: { kind: "window" }, scope: "window" })).toEqual([]);
    expect(keys("start_session", { capture_scope: "window" })).toEqual([]);
  });
});
