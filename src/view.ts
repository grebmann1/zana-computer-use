import type { Activity, State, Status } from "./controller.ts";

export const STATE_COLORS: Record<State, string> = {
  ready: "var(--success, #22c55e)",
  busy: "var(--accent, #3b82f6)",
  locked: "var(--warning, #f59e0b)",
  "permissions-needed": "var(--warning, #f59e0b)",
  stopped: "var(--text-muted, #888)",
  "not-installed": "var(--danger, #ef4444)",
};

export const OUTCOME_COLORS: Record<Activity["outcome"], string> = {
  ok: "var(--success, #22c55e)",
  refused: "var(--warning, #f59e0b)",
  busy: "var(--warning, #f59e0b)",
  denied: "var(--danger, #ef4444)",
  error: "var(--danger, #ef4444)",
  released: "var(--text-muted, #888)",
};

export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export type MenuAction = "start" | "stop" | "restart" | "grant" | "release";

/** Status-chip menu entries that make sense in the current state. */
export function menuFor(status: Status | null): Array<{ id: MenuAction; label: string }> {
  const items: Array<{ id: MenuAction; label: string }> = [];
  if (!status || !status.binary) return items;
  if (status.lease) items.push({ id: "release", label: `Release desktop from ${status.lease.title}` });
  if (status.daemon.running) {
    if (status.state === "permissions-needed") items.push({ id: "grant", label: "Grant macOS permissions" });
    items.push({ id: "restart", label: "Restart daemon" }, { id: "stop", label: "Stop daemon" });
  } else {
    items.push({ id: "start", label: "Start daemon" });
  }
  return items;
}
