import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DaemonStatus, DriverApi, Permissions, ToolSchema } from "./driver.ts";
import { DesktopLease, type Lease } from "./lease.ts";
import type { DriverSource } from "./bundled.ts";
import { INSTALL_COMMAND } from "./constants.ts";
import { RESERVED_PATH_ARGS, SCREENSHOT_TOOLS, approvalsFor, needsLease } from "./policy.ts";

export { INSTALL_COMMAND };

export interface Settings {
  driverSource?: DriverSource;
  binaryPath?: string;
  permissionMode: "standard" | "bounded";
  capabilityManifest?: string;
  leaseIdleMinutes: number;
  autoStart: boolean;
  requireApproval: boolean;
  showAgentCursor?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  permissionMode: "standard",
  leaseIdleMinutes: 10,
  autoStart: true,
  requireApproval: true,
  showAgentCursor: true,
};

export type State = "not-installed" | "stopped" | "permissions-needed" | "locked" | "busy" | "ready";

export interface Status {
  platform?: string;
  state: State;
  label: string;
  binary: string | null;
  version: string | null;
  daemon: DaemonStatus;
  permissions: Permissions;
  screenLocked: boolean | null;
  telemetry: boolean | null;
  lease: Lease | null;
  warnings: string[];
  checkedAt: number;
}

export type Outcome = "ok" | "refused" | "error" | "busy" | "denied" | "released";

export interface Activity {
  id: number;
  at: number;
  threadId: string;
  threadTitle: string;
  tool: string;
  outcome: Outcome;
  code?: string;
  summary: string;
  durationMs: number;
  screenshot?: boolean;
}

export type ApprovalDecision = "allow-once" | "allow-thread" | "deny";

export interface ApprovalRequest {
  tool: string;
  /** Every grant this action needs; "Allow for this thread" grants them all. */
  keys: string[];
  reason: string;
  threadTitle: string;
  args: string;
}

export interface ControllerDeps {
  platform?: string;
  driver: DriverApi;
  settings: () => Settings;
  threadTitle: (threadId: string) => Promise<string>;
  askApproval: (threadId: string, request: ApprovalRequest) => Promise<ApprovalDecision>;
  publish: (event: string, payload: unknown) => void;
  warn: (message: string) => void;
  screenshotDir: string;
  now?: () => number;
}

const MAX_ACTIVITY = 200;
const MAX_RESULT_CHARS = 16_000;
const SCREENSHOTS_KEPT = 20;
const MAX_APPROVAL_ARGS_CHARS = 20_000;
const TOOLS_RETRY_MS = 30_000;
/** Agent hosts abort a tool call after about 5 minutes; give up on an unanswered approval first. */
export const APPROVAL_TIMEOUT_MS = 4 * 60_000;
const SESSION_ENDED = /session has ended; tool call '[a-z_]+' was rejected/;

export function sessionLabel(threadId: string): string {
  return `zcc-${threadId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;
}

function refusal(code: string, message: string) {
  return { status: "refused", refusal: { code, message } };
}

function summarize(body: Record<string, unknown>, fallback: string): string {
  const refused = body.refusal as { message?: unknown } | undefined;
  const pick = [body.summary, body.message, refused?.message, body.error, fallback].find(
    (value) => typeof value === "string" && value.trim(),
  ) as string | undefined;
  const text = (pick ?? "").replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

/**
 * Keep results inside a budget agent hosts accept (some cap tool output near
 * 5k tokens); images travel as files.
 */
export function fitResult(input: Record<string, unknown>, maxChars = MAX_RESULT_CHARS): Record<string, unknown> {
  const { screenshot_png_b64: inlined, screenshot_mime_type: _mime, ...body } = input;
  if (typeof inlined === "string") body.zcc_note = "An inline image was dropped; ZCC returns screenshots as files.";
  if (JSON.stringify(body).length <= maxChars) return body;
  const fitted: Record<string, unknown> = { ...body };
  const size = () => JSON.stringify(fitted).length;
  const notes: string[] = [];
  if (typeof fitted.tree_markdown === "string" && Array.isArray(fitted.elements)) {
    delete fitted.tree_markdown;
    notes.push("tree_markdown dropped (use elements)");
  }
  // Trim the largest lists first: elements, apps, windows, ...
  const lists = Object.keys(fitted)
    .filter((key) => Array.isArray(fitted[key]))
    .sort((a, b) => JSON.stringify(fitted[b]).length - JSON.stringify(fitted[a]).length);
  for (const key of lists) {
    if (size() <= maxChars) break;
    const items = fitted[key] as unknown[];
    let keep = items.length;
    while (keep > 0 && JSON.stringify({ ...fitted, [key]: items.slice(0, keep) }).length > maxChars) {
      keep = Math.floor(keep * 0.8);
    }
    fitted[key] = items.slice(0, keep);
    notes.push(`${key} truncated to ${keep} of ${items.length}`);
  }
  if (size() > maxChars) {
    return {
      status: body.status ?? "ok",
      zcc_truncated: `Result was ${JSON.stringify(body).length} characters; narrow the request (query, max_depth, max_elements).`,
      preview: JSON.stringify(body).slice(0, Math.floor(maxChars / 2)),
    };
  }
  fitted.zcc_truncated = `${notes.join("; ")}. Narrow the request (query, max_depth, max_elements, or list_windows with a pid).`;
  return fitted;
}

function deriveState(status: Omit<Status, "state" | "label">): { state: State; label: string } {
  if (!status.binary) return { state: "not-installed", label: "Not installed" };
  if (!status.daemon.running) return { state: "stopped", label: "Stopped" };
  if (status.platform !== "win32" && (status.permissions.accessibility !== true || status.permissions.screenRecording !== true)) {
    return { state: "permissions-needed", label: "Needs permissions" };
  }
  if (status.screenLocked) return { state: "locked", label: "Screen locked" };
  if (status.lease) return { state: "busy", label: `In use by ${status.lease.title || "a thread"}` };
  return { state: "ready", label: "Ready" };
}

/** Why calls must wait for a daemon restart, or null when its mode is acceptable. */
function modeProblem(daemon: DaemonStatus, settings: Settings): string | null {
  if (!daemon.running || !daemon.permissionMode) return null;
  if (daemon.permissionMode === "unrestricted") {
    return "The daemon runs in unrestricted mode. This plugin never starts it that way; restart it from here.";
  }
  if (daemon.permissionMode !== settings.permissionMode) {
    return `The daemon runs in ${daemon.permissionMode} mode but the plugin is set to ${settings.permissionMode}. Restart the daemon to apply it.`;
  }
  return null;
}

export class Controller {
  readonly lease: DesktopLease;
  private activity: Activity[] = [];
  private nextActivityId = 1;
  private status: Status | null = null;
  private tools: Map<string, ToolSchema> | null = null;
  private toolsVersion: string | null = null;
  private approvals = new Map<string, Set<string>>();
  private titles = new Map<string, string>();
  private shots = new Map<string, { path: string; tool: string; at: number }>();
  private version: { binary: string; value: string | null } | null = null;
  private toolsFailedAt: number | null = null;
  private starting: Promise<void> | null = null;
  private cursors = new Map<string, { signature: string; target?: string; warning?: string }>();
  private shotSeq = 0;
  private readonly now: () => number;

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.lease = new DesktopLease(
      () => this.deps.settings().leaseIdleMinutes * 60_000,
      this.now,
      // Expiry is noticed inside lease reads; finish it outside them.
      (expired) => queueMicrotask(() => void this.endLease(expired, "Released after being idle")),
    );
  }

  // ---- status -----------------------------------------------------------

  async refreshStatus(): Promise<Status> {
    const { driver } = this.deps;
    const binary = driver.binary();
    if (binary && this.version?.binary !== binary) this.version = { binary, value: await driver.version() };
    const daemon: DaemonStatus = binary ? await driver.daemon() : { running: false, pid: null, permissionMode: null };
    const permissions: Permissions = daemon.running
      ? await driver.permissions()
      : { accessibility: null, screenRecording: null };
    const screenLocked = binary ? await driver.screenLocked() : null;
    const telemetry = binary ? await driver.telemetry() : null;
    const settings = this.deps.settings();
    const warnings: string[] = [];
    const mode = modeProblem(daemon, settings);
    if (mode) warnings.push(`${mode} Agent calls are refused until then.`);
    if (settings.permissionMode === "bounded" && !settings.capabilityManifest) {
      warnings.push("Bounded mode needs a capability manifest path in the plugin settings.");
    }
    const base = {
      platform: this.deps.platform ?? process.platform,
      binary,
      version: binary ? (this.version?.value ?? null) : null,
      daemon,
      permissions,
      screenLocked,
      telemetry,
      lease: this.lease.current(),
      warnings,
      checkedAt: this.now(),
    };
    const next: Status = { ...deriveState(base), ...base };
    const changed = !this.status || JSON.stringify({ ...this.status, checkedAt: 0 }) !== JSON.stringify({ ...next, checkedAt: 0 });
    this.status = next;
    if (changed) this.deps.publish("status", next);
    return next;
  }

  async currentStatus(): Promise<Status> {
    return this.status ?? this.refreshStatus();
  }

  /** Re-derive the lease-dependent part without probing the driver again. */
  private publishLease() {
    if (!this.status) return;
    const base = { ...this.status, lease: this.lease.current() };
    this.status = { ...base, ...deriveState(base) };
    this.deps.publish("status", this.status);
  }

  // ---- tool schemas -----------------------------------------------------

  async ensureTools(): Promise<Map<string, ToolSchema> | null> {
    const version = this.version?.value ?? (await this.deps.driver.version());
    if (this.tools && this.toolsVersion === version) return this.tools;
    // Each attempt spawns `cua-driver mcp`; don't respawn on every call while it keeps failing.
    if (this.toolsFailedAt !== null && this.now() - this.toolsFailedAt < TOOLS_RETRY_MS) return this.tools;
    try {
      const list = await this.deps.driver.listTools();
      this.tools = new Map(list.map((tool) => [tool.name, tool]));
      this.toolsVersion = version;
      this.toolsFailedAt = null;
    } catch (error) {
      this.toolsFailedAt = this.now();
      this.deps.warn(`could not read Cua Driver tool schemas: ${(error as Error).message}`);
    }
    return this.tools;
  }

  async describe(tool?: string) {
    const tools = await this.ensureTools();
    if (!tools) return refusal("schemas_unavailable", "Could not read the Cua Driver tool list; check the daemon status.");
    if (!tool) {
      return {
        tools: [...tools.values()].map((entry) => ({
          name: entry.name,
          summary: (entry.description ?? "").split(/(?<=\.)\s|\n/)[0],
          needs_lease: needsLease(entry.name),
        })),
      };
    }
    const entry = tools.get(tool);
    if (!entry) return refusal("unknown_tool", `Cua Driver has no tool named ${tool}.`);
    return { name: entry.name, description: entry.description, input_schema: entry.inputSchema, needs_lease: needsLease(tool) };
  }

  // ---- calls ------------------------------------------------------------

  private record(entry: Omit<Activity, "id" | "at">) {
    const activity: Activity = { id: this.nextActivityId++, at: this.now(), ...entry };
    this.activity.push(activity);
    if (this.activity.length > MAX_ACTIVITY) this.activity.shift();
    this.deps.publish("activity", activity);
    return activity;
  }

  private async title(threadId: string) {
    let title = this.titles.get(threadId);
    if (title === undefined) {
      title = await this.deps.threadTitle(threadId).catch(() => "");
      if (title) this.titles.set(threadId, title);
    }
    return title || threadId.slice(0, 8);
  }

  /** One launch at a time: concurrent callers share it instead of each running `open -n`. */
  private startDaemon(): Promise<void> {
    if (!this.starting) {
      const settings = this.deps.settings();
      this.starting = this.deps.driver
        .start({ permissionMode: settings.permissionMode, capabilityManifest: settings.capabilityManifest })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  private async ensureDaemon(): Promise<{ ok: true; pid: number | null } | { ok: false; code: string; message: string }> {
    const settings = this.deps.settings();
    let daemon = await this.deps.driver.daemon();
    if (!daemon.running) {
      if (!settings.autoStart) {
        return { ok: false, code: "daemon_not_running", message: "The Cua Driver daemon is stopped. Ask the user to start it from the Computer Use status chip." };
      }
      try {
        await this.startDaemon();
        daemon = (await this.refreshStatus()).daemon;
      } catch (error) {
        return { ok: false, code: "daemon_start_failed", message: `Could not start the Cua Driver daemon: ${(error as Error).message}` };
      }
    }
    const mode = modeProblem(daemon, settings);
    if (mode) return { ok: false, code: "daemon_mode_mismatch", message: `${mode} Ask the user to restart it from the Computer Use status chip.` };
    return { ok: true, pid: daemon.pid };
  }

  private async configureCursor(threadId: string, session: unknown, tools: Map<string, ToolSchema> | null, pid: number | null) {
    if (session !== sessionLabel(threadId) || !this.lease.holds(threadId)) return;
    const enabled = this.deps.settings().showAgentCursor !== false;
    const signature = `${this.deps.driver.binary()}:${pid}:${enabled}`;
    const previous = this.cursors.get(threadId);
    if (previous?.signature === signature) return previous.warning;
    const cursor: { signature: string; target?: string; warning?: string } = { signature };
    this.cursors.set(threadId, cursor);
    const commands: Array<[string, Record<string, unknown>]> = [
      ["set_agent_cursor_enabled", { session, enabled }],
      ...(enabled ? [["set_agent_cursor_motion", { session, idle_hide_ms: 0 }] as [string, Record<string, unknown>]] : []),
    ];
    for (const [tool, args] of commands) {
      if (!this.lease.holds(threadId)) return;
      if (!tools?.has(tool)) {
        cursor.warning = "The selected Cua Driver does not expose agent cursor controls.";
        break;
      }
      try {
        const result = await this.deps.driver.call(tool, args);
        if (!result.ok) {
          cursor.warning = `Agent cursor could not be configured: ${result.text || JSON.stringify(result.json)}`;
          break;
        }
      } catch (error) {
        cursor.warning = `Agent cursor could not be configured: ${(error as Error).message}`;
        break;
      }
    }
    if (cursor.warning) this.deps.warn(cursor.warning);
    return cursor.warning;
  }

  /** Inspection has no pointer target upstream. Seed the overlay from the exact window's observed screen frame. */
  private async showInspectionCursor(threadId: string, args: Record<string, unknown>, body: Record<string, unknown>, tools: Map<string, ToolSchema> | null) {
    const cursor = this.cursors.get(threadId);
    if (!cursor || cursor.warning || this.deps.settings().showAgentCursor === false ||
      args.session !== sessionLabel(threadId) || !this.lease.holds(threadId) || !tools?.has("move_cursor")) return;
    const target = args.target as { kind?: unknown; pid?: unknown; window_id?: unknown } | undefined;
    const pid = target?.kind === "window" ? target.pid : args.pid;
    const windowId = target?.kind === "window" ? target.window_id : args.window_id;
    if (typeof pid !== "number" || typeof windowId !== "number" || body.pid !== pid || body.window_id !== windowId) return;
    const key = `${pid}:${windowId}`;
    if (cursor.target === key) return; // Keep the last click's position during repeated verification.
    const elements = Array.isArray(body.elements) ? body.elements : [];
    const root = elements.find((item) => item && typeof item === "object" && item.element_index === 0);
    const frame = (body.window_bounds ?? root?.frame) as { x?: number; y?: number; width?: number; height?: number; w?: number; h?: number } | undefined;
    const width = frame?.width ?? frame?.w;
    const height = frame?.height ?? frame?.h;
    if (!frame || ![frame.x, frame.y, width, height].every((value) => typeof value === "number" && Number.isFinite(value)) || width! <= 0 || height! <= 0) return;
    try {
      const result = await this.deps.driver.call("move_cursor", {
        session: args.session, scope: "window", x: frame.x! + width! / 2, y: frame.y! + height! / 2,
      });
      if (result.ok) cursor.target = key;
      else body.cua_cursor_warning = "The driver could not position the agent cursor on this window.";
    } catch (error) {
      body.cua_cursor_warning = `The driver could not position the agent cursor: ${(error as Error).message}`;
    }
  }

  private screenshotPath(threadId: string, tool: string, ext: string) {
    const dir = join(this.deps.screenshotDir, sessionLabel(threadId));
    mkdirSync(dir, { recursive: true });
    const files = readdirSync(dir)
      .flatMap((name) => {
        try {
          return [{ name, at: statSync(join(dir, name)).mtimeMs }];
        } catch {
          return []; // Pruned by a concurrent call.
        }
      })
      .sort((a, b) => b.at - a.at);
    for (const old of files.slice(SCREENSHOTS_KEPT - 1)) rmSync(join(dir, old.name), { force: true });
    return join(dir, `${this.now()}-${++this.shotSeq}-${tool}.${ext}`);
  }

  async invoke(threadId: string, tool: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const started = this.now();
    const threadTitle = await this.title(threadId);
    const done = (outcome: Outcome, body: Record<string, unknown>, extra: Partial<Activity> = {}) => {
      const code = (body.refusal as { code?: string } | undefined)?.code;
      this.record({ threadId, threadTitle, tool, outcome, code, summary: summarize(body, outcome), durationMs: this.now() - started, ...extra });
      return body;
    };
    const refuse = (code: string, message: string, outcome: Outcome = "refused") => done(outcome, refusal(code, message));

    if (!/^[a-z][a-z0-9_]*$/.test(tool)) return refuse("invalid_tool", "tool must be a Cua Driver tool name such as list_apps.");
    if (!this.deps.driver.binary()) {
      return refuse("driver_not_installed", "The selected Cua Driver is unavailable. Open Plugins → Computer Use → Configuration to set up the included driver or choose an existing installation.");
    }
    const daemon = await this.ensureDaemon();
    if (!daemon.ok) return refuse(daemon.code, daemon.message);
    const tools = await this.ensureTools();
    if (tools && !tools.has(tool)) return refuse("unknown_tool", `Cua Driver has no tool named ${tool}; call cua_driver_describe to list tools.`);
    const reserved = RESERVED_PATH_ARGS.find((name) => input[name] !== undefined);
    if (reserved) {
      return refuse("argument_not_allowed", `${reserved} is not available through ZCC. Screenshots are saved and attached for you; read screenshot_file_path.`);
    }

    // Holding the lease covers the approval wait and the driver call, so it cannot idle out mid-call.
    let endCall = () => {};
    const busy = (holder: Lease) =>
      refuse(
        "desktop_busy",
        `The desktop is in use by thread "${holder.title}" (${holder.threadId}) since ${new Date(holder.acquiredAt).toISOString()}. Wait for it to finish, or ask the user to release it from the Computer Use status chip. Do not use the cua-driver CLI to bypass this.`,
        "busy",
      );
    if (needsLease(tool)) {
      if (await this.deps.driver.screenLocked()) {
        return refuse("screen_locked", "The screen is locked. Ask the user to unlock it, then retry.");
      }
      const acquired = this.lease.tryAcquire(threadId, threadTitle);
      if (!acquired.ok) return busy(acquired.holder);
      if (acquired.acquired) this.publishLease();
      endCall = this.lease.begin(threadId);
    }

    try {
      const args: Record<string, unknown> = { ...input };
      const granted = this.approvals.get(threadId);
      const pending = this.deps.settings().requireApproval
        ? approvalsFor(tool, args).filter((approval) => !granted?.has(approval.key))
        : [];
      if (pending.length) {
        const reason = pending.map((approval) => approval.reason).join("; and ");
        const preview = JSON.stringify(args, null, 2);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const decision = await Promise.race([
          this.deps
            .askApproval(threadId, {
              tool,
              keys: pending.map((approval) => approval.key),
              reason,
              threadTitle,
              args: preview.length > MAX_APPROVAL_ARGS_CHARS ? `${preview.slice(0, MAX_APPROVAL_ARGS_CHARS - 1)}…` : preview,
            })
            .catch(() => "deny" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), APPROVAL_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (decision === "timeout") {
          return refuse(
            "approval_timeout",
            `The user did not answer the approval prompt within ${APPROVAL_TIMEOUT_MS / 60_000} minutes. A late answer is ignored. Ask the user in chat whether they want to ${reason}, then retry.`,
            "denied",
          );
        }
        if (decision === "deny") {
          return refuse("user_denied", `The user declined to let this thread ${reason}. Do not retry it; continue another way or ask the user.`, "denied");
        }
        if (decision === "allow-thread") {
          const next = granted ?? new Set<string>();
          for (const approval of pending) next.add(approval.key);
          this.approvals.set(threadId, next);
        }
        // The user may have taken the desktop back while deciding.
        if (needsLease(tool) && !this.lease.holds(threadId)) {
          const holder = this.lease.current();
          return holder
            ? busy(holder)
            : refuse("lease_released", "The desktop was released while waiting for approval. Retry if the user still wants this.");
        }
      }

      const properties = tools?.get(tool)?.inputSchema?.properties;
      if (properties && "session" in properties && args.session === undefined) args.session = sessionLabel(threadId);
      const cursorControl = tool.startsWith("set_agent_cursor_") || tool === "end_session";
      let cursorWarning: string | undefined;
      if (needsLease(tool) && !cursorControl) cursorWarning = await this.configureCursor(threadId, args.session, tools, daemon.pid);
      if (needsLease(tool) && !this.lease.holds(threadId)) return refuse("lease_released", "The desktop was released before the action could run.");
      const ext = SCREENSHOT_TOOLS[tool];
      const screenshotFile = ext && args.include_screenshot !== false ? this.screenshotPath(threadId, tool, ext) : undefined;

      let result = await this.deps.driver.call(tool, args, { screenshotOutFile: screenshotFile });
      // Releasing a lease ends the thread's session, and the daemon then rejects that label before
      // running anything. Reopen the plugin's own label and retry once.
      if (!result.ok && args.session === sessionLabel(threadId) && SESSION_ENDED.test(result.text)) {
        if (needsLease(tool) && !this.lease.holds(threadId)) return refuse("lease_released", "The desktop was released before the action could run.");
        await this.deps.driver.call("start_session", { session: args.session });
        this.cursors.delete(threadId);
        if (needsLease(tool) && !cursorControl) cursorWarning = await this.configureCursor(threadId, args.session, tools, daemon.pid);
        if (needsLease(tool) && !this.lease.holds(threadId)) return refuse("lease_released", "The desktop was released before the action could run.");
        result = await this.deps.driver.call(tool, args, { screenshotOutFile: screenshotFile });
      }
      const body: Record<string, unknown> = result.json ?? { status: result.ok ? "ok" : "error", output: result.text };
      if (!result.ok && body.status !== "refused") body.status = "error";
      if (cursorWarning) body.cua_cursor_warning = cursorWarning;
      if (result.ok && body.status !== "refused" && body.status !== "error" && tool === "get_window_state") await this.showInspectionCursor(threadId, args, body, tools);
      if (cursorControl) this.cursors.delete(threadId);
      const hasShot = Boolean(screenshotFile && existsSync(screenshotFile));
      if (hasShot) {
        body.screenshot_file_path = screenshotFile;
        this.shots.set(threadId, { path: screenshotFile!, tool, at: this.now() });
      }
      const outcome: Outcome = body.status === "refused" ? "refused" : result.ok ? "ok" : "error";
      done(outcome, body, { screenshot: hasShot });
      return fitResult(body);
    } finally {
      endCall();
    }
  }

  // ---- lifecycle --------------------------------------------------------

  async releaseLease(reason: string, threadId?: string): Promise<Lease | null> {
    const holder = this.lease.release(threadId);
    if (!holder) return null;
    await this.endLease(holder, reason);
    return holder;
  }

  private async endLease(holder: Lease, reason: string) {
    this.cursors.delete(holder.threadId);
    await this.deps.driver.call("end_session", { session: sessionLabel(holder.threadId) }).catch(() => undefined);
    this.record({
      threadId: holder.threadId,
      threadTitle: holder.title,
      tool: "lease",
      outcome: "released",
      summary: reason,
      durationMs: 0,
    });
    this.publishLease();
  }

  forgetThread(threadId: string) {
    this.cursors.delete(threadId);
    this.approvals.delete(threadId);
    this.titles.delete(threadId);
    this.shots.delete(threadId);
  }

  async start() {
    await this.startDaemon();
    return this.refreshStatus();
  }

  async stop() {
    await this.releaseLease("Daemon stopped");
    await this.deps.driver.stop();
    return this.refreshStatus();
  }

  async restart() {
    await this.releaseLease("Daemon restarted");
    await this.deps.driver.stop();
    return this.start();
  }

  async grant() {
    const output = await this.deps.driver.grant();
    return { output, status: await this.refreshStatus() };
  }

  async setTelemetry(enabled: boolean) {
    await this.deps.driver.setTelemetry(enabled);
    return this.refreshStatus();
  }

  // ---- views ------------------------------------------------------------

  recentActivity(threadId?: string, limit = 50): Activity[] {
    const rows = threadId ? this.activity.filter((row) => row.threadId === threadId) : this.activity;
    return rows.slice(-limit).reverse();
  }

  threadState(threadId: string) {
    const lease = this.lease.current();
    const shot = this.shots.get(threadId);
    return {
      holdsLease: lease?.threadId === threadId,
      lease,
      activity: this.recentActivity(threadId),
      screenshot: shot ? { tool: shot.tool, at: shot.at } : null,
    };
  }

  screenshot(threadId: string): string | null {
    const shot = this.shots.get(threadId);
    if (!shot || !existsSync(shot.path)) return null;
    const mime = shot.path.endsWith(".jpg") ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${readFileSync(shot.path).toString("base64")}`;
  }
}
