import { writeFileSync } from "node:fs";
import type { CallOptions, CallResult, DaemonStatus, DriverApi, Permissions, ServeOptions, ToolSchema } from "../src/driver.ts";

const withSession = (name: string): ToolSchema => ({
  name,
  description: `${name}. More text.`,
  inputSchema: { properties: { session: {}, pid: {}, window_id: {} } },
});

export const FAKE_TOOLS: ToolSchema[] = [
  { name: "list_apps", description: "List apps.", inputSchema: { properties: { session: {} } } },
  withSession("get_window_state"),
  withSession("click"),
  withSession("bring_to_front"),
  withSession("type_text"),
  withSession("get_desktop_state"),
  withSession("kill_app"),
  withSession("end_session"),
  withSession("zoom"),
  withSession("start_session"),
  withSession("set_agent_cursor_enabled"),
  withSession("set_agent_cursor_motion"),
  withSession("move_cursor"),
  withSession("get_agent_cursor_state"),
  { name: "list_sessions", description: "List sessions.", inputSchema: { properties: {} } },
];

/** Scriptable stand-in for the installed cua-driver binary. */
export class FakeDriver implements DriverApi {
  installed = true;
  daemonState: DaemonStatus = { running: true, pid: 4242, permissionMode: "standard" };
  perms: Permissions = { accessibility: true, screenRecording: true };
  locked = false;
  telemetryEnabled: boolean | null = true;
  calls: Array<{ tool: string; args: Record<string, unknown>; options: CallOptions }> = [];
  starts: ServeOptions[] = [];
  stops = 0;
  /** Like the CLI, writes the response image to `--screenshot-out-file` when one is given. */
  respond: (tool: string, args: Record<string, unknown>, options: CallOptions) => CallResult | Promise<CallResult> = (tool, _args, options) => {
    if (options.screenshotOutFile) writeFileSync(options.screenshotOutFile, "png-bytes");
    return { ok: true, exitCode: 0, json: { status: "ok", summary: `${tool} done` }, text: "" };
  };

  binary() {
    return this.installed ? "/fake/cua-driver" : null;
  }
  async version() {
    return "0.33.3";
  }
  async daemon() {
    return { ...this.daemonState };
  }
  async permissions() {
    return { ...this.perms };
  }
  async telemetry() {
    return this.telemetryEnabled;
  }
  async setTelemetry(enabled: boolean) {
    this.telemetryEnabled = enabled;
  }
  async screenLocked() {
    return this.locked;
  }
  async listTools() {
    return FAKE_TOOLS;
  }
  async call(tool: string, args: Record<string, unknown>, options: CallOptions = {}) {
    this.calls.push({ tool, args, options });
    return this.respond(tool, args, options);
  }
  async start(options: ServeOptions) {
    this.starts.push(options);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.daemonState = { running: true, pid: 5151, permissionMode: options.permissionMode };
  }
  async stop() {
    this.stops++;
    this.daemonState = { running: false, pid: null, permissionMode: null };
  }
  async grant() {
    return "requested";
  }
  toolCalls(name: string) {
    return this.calls.filter((call) => call.tool === name);
  }
}
