/**
 * Read-only diagnostics that never touch app state or snapshot caches, so any
 * thread may call them without holding the desktop lease.
 */
const LEASE_FREE = new Set([
  "check_permissions",
  "health_report",
  "get_config",
  "list_apps",
  "list_windows",
  "get_screen_size",
  "get_cursor_position",
  "get_recording_state",
  "list_sessions",
  "get_session",
  "get_session_state",
  "get_agent_cursor_state",
  "check_for_update",
]);

/** Tools whose response carries an image the plugin writes to a file. */
export const SCREENSHOT_TOOLS: Record<string, string> = {
  get_window_state: "png",
  get_desktop_state: "png",
  zoom: "jpg",
};

/** Arguments that make the driver write to a path the agent chose; the plugin owns screenshot paths. */
export const RESERVED_PATH_ARGS = ["screenshot_out_file", "debug_image_out"];

export function needsLease(tool: string): boolean {
  return !LEASE_FREE.has(tool);
}

export interface Approval {
  /** Grants are remembered per thread under this key. */
  key: string;
  reason: string;
}

const TOOL_APPROVALS: Record<string, Approval> = {
  bring_to_front: { key: "foreground", reason: "bring an app to the front, taking focus away from you" },
  get_desktop_state: { key: "desktop", reason: "capture your whole screen, not a single app window" },
  escalate_session: { key: "desktop", reason: "switch its session to whole-desktop capture and input" },
  kill_app: { key: "kill_app", reason: "force-quit an app (unsaved work is lost)" },
  clipboard_read: { key: "clipboard", reason: "read or replace your clipboard" },
  clipboard_write: { key: "clipboard", reason: "read or replace your clipboard" },
  set_config: { key: "set_config", reason: "change Cua Driver's global configuration" },
  install_extension: { key: "install", reason: "install software into Cua Driver" },
  install_ffmpeg: { key: "install", reason: "install software into Cua Driver" },
  replay_trajectory: { key: "replay", reason: "replay a recorded sequence of actions" },
};

/** Arguments naming local files or folders the driver reads or writes. */
const PATH_ARGS: Record<string, { args: string[]; verb: string }> = {
  start_recording: { args: ["output_dir"], verb: "write a recording to" },
  browser_download: { args: ["destination_root"], verb: "save a download into" },
  browser_set_input_files: { args: ["files"], verb: "upload" },
  clipboard_write: { args: ["file_path", "image_path"], verb: "put on the clipboard" },
  replay_trajectory: { args: ["dir"], verb: "replay actions from" },
};

const READ_ONLY_PAGE_ACTIONS = new Set(["get_text", "query_dom"]);

const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

/**
 * Every approval an action needs from the user, most specific first. The checks
 * err toward asking: the driver accepts `dispatch` as an alias of
 * `delivery_mode`, compares case-insensitively, and treats `scope:"desktop"`
 * without a window as a whole-desktop action.
 */
export function approvalsFor(tool: string, args: Record<string, unknown>): Approval[] {
  const found: Approval[] = [];
  const add = (approval: Approval) => {
    if (!found.some((entry) => entry.key === approval.key)) found.push(approval);
  };
  const paths = PATH_ARGS[tool];
  if (paths) {
    const values = paths.args.flatMap((name) => {
      const value = args[name];
      return Array.isArray(value) ? value.map(String) : value === undefined || value === null ? [] : [String(value)];
    });
    // A grant covers only these exact paths.
    if (values.length) add({ key: `paths:${tool}:${JSON.stringify(values)}`, reason: `${paths.verb} ${values.join(", ")}` });
  }
  const specific = TOOL_APPROVALS[tool];
  if (specific) add(specific);
  if (tool === "page" && !READ_ONLY_PAGE_ACTIONS.has(lower(args.action))) {
    add({ key: "page_script", reason: "run JavaScript or change a web page through the legacy page tool" });
  }
  const target = args.target as { kind?: unknown } | undefined;
  if (
    (target && typeof target === "object" && lower(target.kind) === "desktop") ||
    lower(args.scope) === "desktop" ||
    lower(args.capture_scope) === "desktop"
  ) {
    add({ key: "desktop", reason: "act on your whole desktop with the real mouse and keyboard" });
  }
  if (lower(args.delivery_mode) === "foreground" || lower(args.dispatch) === "foreground") {
    add({ key: "foreground", reason: "bring a window to the front and use the real mouse and keyboard" });
  }
  return found;
}
