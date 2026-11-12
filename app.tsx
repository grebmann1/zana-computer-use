import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@zana-ai/zcc-plugin-sdk/app";
import type { Activity, ApprovalRequest, Settings, Status } from "./src/controller.ts";
import { INSTALL_COMMAND, WINDOWS_INSTALL_COMMAND } from "./src/constants.ts";
import type { SetupInfo } from "./src/bundled.ts";
import { OUTCOME_COLORS, STATE_COLORS, ago, menuFor, type MenuAction } from "./src/view.ts";

type Overview = { status: Status; activity: Activity[]; settings: Settings; setup?: SetupInfo };
type ThreadView = {
  holdsLease: boolean;
  lease: Status["lease"];
  activity: Activity[];
  screenshot: { tool: string; at: number } | null;
};

const muted: CSSProperties = { color: "var(--text-muted)", fontSize: 12 };
const card: CSSProperties = {
  border: "1px solid var(--border, rgba(127,127,127,.25))",
  borderRadius: 8,
  padding: 12,
  display: "grid",
  gap: 8,
};
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };

function Dot({ color }: { color: string }) {
  return <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: color, flex: "none" }} />;
}

function useOverview() {
  const rpc = useRpc();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    rpc
      .call("status")
      .then((value) => {
        setData(value as Overview);
        setError("");
      })
      .catch((err: Error) => setError(err.message));
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("cua.status", load);
  useRealtime("cua.activity", load);
  return { data, error, reload: load, rpc };
}

function useAction(rpc: ReturnType<typeof useRpc>, after: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const run = (method: string, args?: unknown) => {
    setBusy(method);
    setMessage("");
    rpc
      .call(method, args)
      .then((result) => {
        const output = (result as { output?: string } | null)?.output;
        if (output) setMessage(output);
      })
      .catch((err: Error) => setMessage(err.message))
      .finally(() => {
        setBusy(null);
        after();
      });
  };
  return { busy, message, run };
}

function ActivityList({ rows, showThread }: { rows: Activity[]; showThread: boolean }) {
  if (rows.length === 0) return <p style={muted}>No agent calls yet.</p>;
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
      {rows.map((entry) => (
        <li key={entry.id} style={{ display: "grid", gap: 2 }}>
          <div style={row}>
            <Dot color={OUTCOME_COLORS[entry.outcome]} />
            <code style={{ fontSize: 12 }}>{entry.tool}</code>
            <span style={muted}>
              {entry.outcome}
              {entry.code ? ` · ${entry.code}` : ""} · {entry.durationMs} ms · {ago(entry.at)}
              {showThread ? ` · ${entry.threadTitle}` : ""}
            </span>
          </div>
          {entry.summary ? <div style={{ ...muted, paddingLeft: 16 }}>{entry.summary}</div> : null}
        </li>
      ))}
    </ol>
  );
}

function Permission({
  label,
  value,
  words = ["granted", "missing"],
}: {
  label: string;
  value: boolean | null;
  words?: [string, string];
}) {
  const color = value === true ? STATE_COLORS.ready : value === false ? STATE_COLORS["not-installed"] : STATE_COLORS.stopped;
  return (
    <div style={row}>
      <Dot color={color} />
      <span>{label}</span>
      <span style={muted}>{value === null ? "unknown" : value ? words[0] : words[1]}</span>
    </div>
  );
}

const setupStyles = `
  .cua-setup { padding: 20px; border: 1px solid var(--border, #dce1e8); border-radius: 12px; color: var(--text-primary); }
  .cua-setup h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.15px; }
  .cua-setup p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--text-muted); }
  .cua-setup-header { display: grid; gap: 5px; }
  .cua-setup-platform { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 16px 0 20px; }
  .cua-setup-tabs { display: inline-flex; gap: 3px; padding: 3px; border-radius: 8px; background: var(--bg-input, rgba(127,127,127,.08)); border: 1px solid var(--border, #dce1e8); }
  .cua-setup-tabs button { appearance: none; border: 1px solid transparent; background: transparent; border-radius: 5px; padding: 5px 12px; font: inherit; font-size: 12px; color: var(--text-muted); cursor: pointer; }
  .cua-setup-tabs button[aria-pressed="true"] { color: var(--text-primary); background: var(--bg-panel, var(--bg-base, white)); border-color: var(--border, #dce1e8); box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  .cua-setup-tabs button:hover { color: var(--text-primary); }
  .cua-setup-tabs button:focus-visible { outline: 2px solid var(--accent-blue, #2563eb); outline-offset: 2px; }
  .cua-setup-host { font-size: 11px; color: var(--text-muted); }
  .cua-setup-steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 20px; }
  .cua-setup-step { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; }
  .cua-setup-number { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; color: var(--accent-blue, #2563eb); background: color-mix(in srgb, var(--accent-blue, #2563eb) 10%, transparent); font-size: 11px; font-weight: 650; }
  .cua-setup-step-body { display: grid; gap: 7px; min-width: 0; padding-top: 3px; }
  .cua-setup h3 { margin: 0; font-size: 12px; font-weight: 650; line-height: 18px; }
  .cua-setup-included { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 2px 0; }
  .cua-setup-ready { display: inline-flex; align-items: center; gap: 7px; padding: 5px 9px; border-radius: 6px; background: color-mix(in srgb, var(--accent-green, #168348) 8%, transparent); font-size: 12px; }
  .cua-setup-version { color: var(--text-muted); font-size: 11px; }
  .cua-setup-path { display: grid; gap: 4px; padding: 9px 11px; border-radius: 6px; background: var(--bg-input, rgba(127,127,127,.06)); }
  .cua-setup-path span { font-size: 11px; color: var(--text-muted); }
  .cua-setup code { font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; user-select: text; }
  .cua-setup details { font-size: 11px; color: var(--text-muted); }
  .cua-setup summary { cursor: pointer; width: fit-content; }
  .cua-setup details[open] summary { margin-bottom: 7px; }
  .cua-setup details p { margin-bottom: 4px; }
  .cua-setup-permissions { display: flex; flex-wrap: wrap; gap: 6px; }
  .cua-setup-permissions span { font-size: 11px; padding: 3px 7px; border: 1px solid var(--border, #dce1e8); border-radius: 5px; }
  .cua-setup-footer { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 20px; padding-top: 13px; border-top: 1px solid var(--border, #dce1e8); font-size: 11px; }
  .cua-setup-footer a { color: var(--accent-blue, #2563eb); text-decoration: none; }
  .cua-setup-footer a:hover { text-decoration: underline; }
  @media (max-width: 500px) { .cua-setup { padding: 16px; } .cua-setup-step { gap: 9px; } }
`;

function SetupStep({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return <li className="cua-setup-step">
    <span className="cua-setup-number" aria-hidden="true">{number}</span>
    <div className="cua-setup-step-body"><h3>{title}</h3>{children}</div>
  </li>;
}

function SetupGuide({ setup, status, busy, prepare }: {
  setup?: SetupInfo; status: Status; busy: boolean; prepare: () => void;
}) {
  const [platform, setPlatform] = useState(setup?.platform === "win32" || status.platform === "win32" ? "win32" : "darwin");
  const thisPlatform = setup?.platform ?? status.platform ?? "darwin";
  const windows = platform === "win32";
  const appPath = status.binary?.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1];
  return (
    <section className="cua-setup" aria-label="Computer Use setup guide">
      <style>{setupStyles}</style>
      <header className="cua-setup-header">
        <h2>Set up Computer Use</h2>
        <p>Connect Cua Driver to the computer running Zana in three steps.</p>
      </header>
      <div className="cua-setup-platform">
        <div className="cua-setup-tabs" role="group" aria-label="Platform guide">
          <button type="button" aria-label="macOS guide" aria-pressed={!windows} onClick={() => setPlatform("darwin")}>macOS</button>
          <button type="button" aria-label="Windows guide" aria-pressed={windows} onClick={() => setPlatform("win32")}>Windows</button>
        </div>
        <span className="cua-setup-host">This computer: {thisPlatform === "darwin" ? "macOS" : thisPlatform === "win32" ? "Windows" : thisPlatform}</span>
      </div>
      <ol className="cua-setup-steps" role="list">
        <SetupStep number={1} title="Choose your driver">
          <p>Choose <b>Included with plugin</b> in the settings above, or <b>Custom path</b> for your installed {windows ? "cua-driver.exe" : "CuaDriver.app"}. <b>Automatic</b> prefers an existing installation.</p>
          {setup ? <>
            <div className="cua-setup-included">
              {setup.includedReady ? (
                <span className="cua-setup-ready" role="status"><Dot color={STATE_COLORS.ready} />Included driver ready <span className="cua-setup-version">v{setup.includedVersion}</span></span>
              ) : (
                <button type="button" className="btn" disabled={busy || !setup.includedAvailable} onClick={prepare}>
                  {busy ? "Setting up…" : `Set up included Cua Driver ${setup.includedVersion}`}
                </button>
              )}
              <p>{setup.includedReady ? (setup.source === "included" ? "Ready to use on this computer." : "Select Included with plugin above to use it.") : "Set up a local copy without replacing your installation."}</p>
            </div>
            {!setup.includedAvailable ? <p role="alert">No included release is available for this platform. Choose an existing installation or use the installer below.</p> : null}
          </> : null}
          <div className="cua-setup-path"><span>Current driver</span><code>{status.binary ?? "No driver selected"}</code></div>
          <details>
            <summary>Install Cua Driver yourself</summary>
            <p>Run in {windows ? "PowerShell" : "Terminal"}, then select the installation above:</p>
            <code>{windows ? WINDOWS_INSTALL_COMMAND : INSTALL_COMMAND}</code>
          </details>
        </SetupStep>
        <SetupStep number={2} title={windows ? "Use your interactive Windows desktop" : "Grant macOS permissions"}>
          {windows ? <>
            <p>Sign in and unlock Windows. Run Zana and Cua Driver in the same account and desktop session, rather than a service or SSH session.</p>
            <p>Windows needs no macOS privacy switches. Start with an ordinary app; administrator apps and UAC prompts may refuse input.</p>
          </> : <>
            <p>Start the daemon below, then open <b>System Settings → Privacy &amp; Security</b>. Enable <b>CuaDriver</b> in both:</p>
            <div className="cua-setup-permissions"><span>Accessibility</span><span>Screen &amp; System Audio Recording</span></div>
            <p>If the app is missing, add the selected CuaDriver.app with the + button. On older macOS versions, look for Screen Recording.</p>
            {appPath ? <code>{appPath}</code> : null}
            <p>Approve the macOS prompts, then restart the daemon to apply the permissions.</p>
          </>}
        </SetupStep>
        <SetupStep number={3} title="Start and check">
          <p>Click <b>Start</b>, or <b>Restart</b> after changing the driver or permissions. <b>Refresh</b> should show Ready.</p>
          <p>Open an app and ask an agent to inspect its window to check the first capture.</p>
        </SetupStep>
      </ol>
      <footer className="cua-setup-footer">
        <a href="https://cua.ai/docs/cua-driver/quickstart">Setup documentation</a>
        <a href="https://cua.ai/docs/cua-driver/concepts/platform-support">Platform requirements</a>
        {setup ? <a href={setup.releaseUrl}>Release &amp; license</a> : null}
      </footer>
    </section>
  );
}

function DesktopSettings() {
  const { data, error, reload, rpc } = useOverview();
  const action = useAction(rpc, reload);
  if (error) return <div style={{ padding: 24 }}>Could not load Computer Use status: {error}</div>;
  if (!data) return <div style={{ padding: 24, ...muted }}>Loading…</div>;
  const { status, activity, settings, setup } = data;
  const button = (method: string, label: string, args?: unknown, primary = false) => (
    <button
      type="button"
      className={primary ? "btn primary" : "btn"}
      disabled={action.busy !== null}
      onClick={() => action.run(method, args)}
    >
      {action.busy === method ? "…" : label}
    </button>
  );
  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <SetupGuide setup={setup} status={status} busy={action.busy === "prepareIncluded"} prepare={() => action.run("prepareIncluded")} />
      {action.message ? <pre role="status" style={{ ...card, whiteSpace: "pre-wrap", margin: 0 }}>{action.message}</pre> : null}
      <header style={{ ...row, justifyContent: "space-between" }}>
        <div style={row}>
          <Dot color={STATE_COLORS[status.state]} />
          <h2 style={{ margin: 0 }}>Desktop status</h2>
          <span data-testid="cua-state">{status.label}</span>
        </div>
        {button("refresh", "Refresh")}
      </header>

      {status.warnings.map((warning) => (
        <div key={warning} role="alert" style={{ ...card, borderColor: STATE_COLORS.locked }}>
          {warning}
        </div>
      ))}

      {!status.binary ? (
        <section style={card}>
          <strong>The selected Cua Driver is not available</strong>
          <span style={muted}>Set up the included driver above, or select an existing Cua Driver path. A custom path must exist; it never falls back to another installation.</span>
        </section>
      ) : (
        <>
          <section style={card}>
            <strong>Daemon</strong>
            <span style={muted}>
              {status.version ? `v${status.version} · ` : ""}
              {status.daemon.running
                ? `running (pid ${status.daemon.pid}, ${status.daemon.permissionMode} mode)`
                : "stopped"}{" "}
              · plugin mode: {settings.permissionMode}
            </span>
            <div style={row}>
              {status.daemon.running ? (
                <>
                  {button("restart", "Restart")}
                  {button("stop", "Stop")}
                </>
              ) : (
                button("start", "Start", undefined, true)
              )}
            </div>
          </section>

          {status.platform !== "win32" ? <section style={card}>
            <strong>macOS permissions</strong>
            <Permission label="Accessibility" value={status.permissions.accessibility} />
            <Permission label="Screen & System Audio Recording" value={status.permissions.screenRecording} />
            <Permission
              label="Screen"
              value={status.screenLocked === null ? null : !status.screenLocked}
              words={["unlocked", "locked, unlock it to let agents work"]}
            />
            {status.state === "permissions-needed" && status.daemon.running ? (
              <div style={row}>
                {button("grant", "Open macOS permissions", undefined, true)}
                <span style={muted}>Then switch CuaDriver on in System Settings.</span>
              </div>
            ) : null}
          </section> : <section style={card}>
            <strong>Windows desktop</strong>
            <span style={muted}>Keep this desktop signed in and unlocked. Zana and Cua Driver must run in the same user session.</span>
          </section>}

          <section style={card}>
            <strong>Desktop lease</strong>
            {status.lease ? (
              <div style={row}>
                <span>
                  In use by <b>{status.lease.title}</b> since {ago(status.lease.acquiredAt)}, last action{" "}
                  {ago(status.lease.lastUsedAt)}
                </span>
                {button("release", "Release")}
              </div>
            ) : (
              <span style={muted}>Free. The next thread that acts on an app takes it.</span>
            )}
          </section>

          <section style={card}>
            <strong>Telemetry</strong>
            <div style={row}>
              <span style={muted}>
                Cua Driver's own product telemetry is{" "}
                {status.telemetry === null ? "unknown" : status.telemetry ? "enabled" : "disabled"}.
              </span>
              {status.telemetry === null
                ? null
                : button("telemetry", status.telemetry ? "Disable" : "Enable", { enabled: !status.telemetry })}
            </div>
          </section>
        </>
      )}

      <section style={card}>
        <strong>Recent agent calls</strong>
        <ActivityList rows={activity} showThread />
      </section>
    </div>
  );
}

function ThreadDesktopPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc();
  const [view, setView] = useState<ThreadView | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [shotAt, setShotAt] = useState<number | null>(null);
  const load = useCallback(() => {
    rpc.call("thread", { threadId }).then((value) => setView(value as ThreadView)).catch(() => undefined);
  }, [rpc, threadId]);
  useEffect(load, [load]);
  useRealtime("cua.status", load);
  useRealtime("cua.activity", (payload) => {
    if ((payload as Activity | undefined)?.threadId === threadId) load();
  });
  // Keyed on the whole view so a failed fetch is retried on the next reload.
  useEffect(() => {
    const at = view?.screenshot?.at ?? null;
    if (at === null || at === shotAt) return;
    rpc
      .call("screenshot", { threadId })
      .then((value) => {
        setImage((value as { dataUrl: string | null }).dataUrl);
        setShotAt(at);
      })
      .catch(() => undefined);
  }, [rpc, threadId, view, shotAt]);
  if (!view) return <div style={{ padding: 16, ...muted }}>Loading…</div>;
  const lease = view.holdsLease
    ? "This thread controls the desktop."
    : view.lease
      ? `The desktop is in use by ${view.lease.title}.`
      : "The desktop is free.";
  return (
    <div style={{ padding: 16, display: "grid", gap: 12, alignContent: "start", height: "100%", boxSizing: "border-box", overflow: "auto" }}>
      <div style={row}>
        <Dot color={view.holdsLease ? STATE_COLORS.busy : STATE_COLORS.stopped} />
        <span>{lease}</span>
        {view.holdsLease ? (
          <button type="button" className="btn" onClick={() => void rpc.call("release", { threadId }).then(load)}>
            Take it back
          </button>
        ) : null}
      </div>
      {image && view.screenshot ? (
        <figure style={{ margin: 0, display: "grid", gap: 4 }}>
          <img
            src={image}
            alt={`Latest ${view.screenshot.tool} capture`}
            style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid var(--border, rgba(127,127,127,.25))" }}
          />
          <figcaption style={muted}>
            Latest {view.screenshot.tool} capture, {ago(view.screenshot.at)}
          </figcaption>
        </figure>
      ) : (
        <p style={muted}>No screenshot from this thread yet.</p>
      )}
      <ActivityList rows={view.activity} showThread={false} />
    </div>
  );
}

function StatusChip(props: {
  pluginId: string;
  openMenu: (items: Array<{ id: string; label: string; run: () => void }>) => boolean;
}) {
  const rpc = useRpc();
  const [status, setStatus] = useState<Status | null>(null);
  const load = useCallback(() => {
    rpc
      .call("status")
      .then((value) => setStatus((value as Overview).status))
      .catch(() => undefined);
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("cua.status", (payload) => setStatus(payload as Status));
  const run = (method: MenuAction) => () => void rpc.call(method).catch(() => undefined).finally(load);
  const actions: Record<MenuAction, () => void> = {
    start: run("start"),
    stop: run("stop"),
    restart: run("restart"),
    grant: run("grant"),
    release: run("release"),
  };
  const label = status ? `Computer Use: ${status.label}` : "Computer Use";
  return (
    <button
      type="button"
      className="statusbar-item"
      title={status?.warnings[0] ?? `Computer Use: ${status?.label ?? "loading"}`}
      aria-label={label}
      onClick={() => props.openMenu(menuFor(status).map((item) => ({ ...item, run: actions[item.id] })))}
    >
      <Dot color={status ? STATE_COLORS[status.state] : STATE_COLORS.stopped} />
      <span>{label}</span>
    </button>
  );
}

function ApprovalForm(props: {
  interaction: { payload: unknown };
  submit: (value: unknown) => void;
  cancel: () => void;
}) {
  const request = (props.interaction.payload ?? {}) as Partial<ApprovalRequest>;
  const choose = (decision: string) => () => props.submit({ decision });
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <p style={{ margin: 0 }}>
        <b>{request.threadTitle || "This thread"}</b> wants to {request.reason || "run a sensitive Computer Use action"}.
      </p>
      <code style={muted}>{request.tool}</code>
      <pre style={{ ...muted, margin: 0, maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {request.args}
      </pre>
      <div style={row}>
        <button type="button" className="btn primary" onClick={choose("allow-once")}>
          Allow once
        </button>
        <button type="button" className="btn" onClick={choose("allow-thread")}>
          Allow for this thread
        </button>
        <button type="button" className="btn" onClick={choose("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "desktop",
    component: DesktopSettings,
  });
  app.slots.projectStatusbarItem({
    id: "desktop",
    align: "right",
    tooltip: "Computer Use",
    icon: "MousePointerClick",
    item: StatusChip as (props: never) => ReactNode,
  });
  app.slots.threadPanelAction({
    id: "desktop",
    title: "Desktop",
    icon: "MousePointerClick",
    layout: "flush",
    component: ThreadDesktopPanel,
  });
  app.slots.pendingInteraction({
    id: "cua-driver-approval",
    component: ApprovalForm,
  });
});
