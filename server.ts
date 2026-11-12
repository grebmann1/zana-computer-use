import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZccPluginApi } from "@zana-ai/zcc-plugin-sdk/server";
import {
  Controller,
  DEFAULT_SETTINGS,
  type Settings,
  type Status,
} from "./src/controller.ts";
import { CuaDriver, type DriverApi } from "./src/driver.ts";
import { approvalDecision, eventThreadId, toToolResult } from "./src/host.ts";
import { BundledDriver } from "./src/bundled.ts";

export const APPROVAL_RENDERER_ID = "cua-driver-approval";
const POLL_MS = 15_000;

const INSTRUCTIONS =
  "Cua Driver is available: to see or operate desktop apps on the user's macOS or Windows computer, use the `cua_driver` tool " +
  "(load the `cua-driver` skill first). Do not run the `cua-driver` shell CLI directly; the tool applies " +
  "the shared desktop lease and the user's approvals.";

function readSettings(values: Record<string, string | number | boolean | undefined>): Settings {
  const minutes = Number(values.leaseIdleMinutes);
  return {
    driverSource: values.driverSource === "Included with plugin" ? "included" : values.driverSource === "Custom path" ? "custom" : "automatic",
    binaryPath: typeof values.binaryPath === "string" && values.binaryPath.trim() ? values.binaryPath.trim() : undefined,
    permissionMode: values.permissionMode === "bounded" ? "bounded" : "standard",
    capabilityManifest:
      typeof values.capabilityManifest === "string" && values.capabilityManifest.trim()
        ? values.capabilityManifest.trim()
        : undefined,
    leaseIdleMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SETTINGS.leaseIdleMinutes,
    autoStart: values.autoStart !== false,
    requireApproval: values.requireApproval !== false,
    showAgentCursor: values.showAgentCursor !== false,
  };
}

function statusText(status: Status): string {
  const yesNo = (value: boolean | null) => (value === null ? "unknown" : value ? "granted" : "missing");
  const lines = [
    `state:          ${status.state} (${status.label})`,
    `binary:         ${status.binary ?? "not found"}${status.version ? ` (${status.version})` : ""}`,
    `daemon:         ${status.daemon.running ? `running, pid ${status.daemon.pid}, ${status.daemon.permissionMode} mode` : "stopped"}`,
    `accessibility:  ${yesNo(status.permissions.accessibility)}`,
    `screen capture: ${yesNo(status.permissions.screenRecording)}`,
    `screen locked:  ${status.screenLocked === null ? "unknown" : status.screenLocked ? "yes" : "no"}`,
    `telemetry:      ${status.telemetry === null ? "unknown" : status.telemetry ? "enabled" : "disabled"}`,
    `lease:          ${status.lease ? `${status.lease.title} (${status.lease.threadId})` : "free"}`,
  ];
  for (const warning of status.warnings) lines.push(`warning:        ${warning}`);
  if (!status.binary) lines.push("setup:          Plugins → Computer Use → Configuration; prepare the included driver or choose an existing path");
  return `${lines.join("\n")}\n`;
}

export function createPlugin(makeDriver?: (binaryPath: () => string | undefined) => DriverApi, bundled = new BundledDriver(fileURLToPath(new URL(".", import.meta.url)))) {
  return async function plugin(zcc: ZccPluginApi) {
    const settingsHandle = zcc.settings.define({
      driverSource: {
        type: "select", label: "Cua Driver source",
        description: "Use the included driver, choose your own path, or automatically detect an existing installation. Restart the daemon after changing its source.",
        options: ["Automatic", "Included with plugin", "Custom path"], default: "Automatic",
      },
      permissionMode: {
        type: "select",
        label: "Permission mode",
        description: "standard is Cua Driver's default. bounded limits tools and apps to a reviewed capability manifest. unrestricted is never offered.",
        options: ["standard", "bounded"],
        default: "standard",
      },
      capabilityManifest: {
        type: "string",
        label: "Capability manifest (bounded mode)",
        description: "Absolute path to a capability YAML. Setting it asserts you reviewed this exact file.",
      },
      requireApproval: {
        type: "boolean",
        label: "Ask before foreground, whole-desktop, clipboard and force-quit actions",
        default: true,
      },
      leaseIdleMinutes: {
        type: "number",
        label: "Release the desktop after this many idle minutes",
        default: DEFAULT_SETTINGS.leaseIdleMinutes,
        min: 1,
        max: 120,
      },
      autoStart: { type: "boolean", label: "Start the Cua Driver daemon when an agent needs it", default: true },
      showAgentCursor: {
        type: "boolean", label: "Show the agent cursor during desktop work", default: true,
        description: "Keep Cua's cursor visible during inspections and actions until the thread releases the desktop. Your own mouse pointer stays in place. On macOS, Cua currently draws the overlay on the main monitor only.",
      },
      binaryPath: {
        type: "string", label: "Existing Cua Driver path",
        description: "For Custom path, enter CuaDriver.app (macOS) or cua-driver.exe (Windows). Automatic also honors this path when supplied.",
      },
    });
    let settings = readSettings(await settingsHandle.get());

    const driver = makeDriver ? makeDriver(() => settings.binaryPath) : new CuaDriver(() => settings.binaryPath, undefined, undefined, {
      source: () => settings.driverSource ?? "automatic",
      includedPath: () => { const info = bundled.info("included"); return info.includedReady ? info.includedPath : null; },
    });
    const controller = new Controller({
      driver,
      settings: () => settings,
      screenshotDir: join(tmpdir(), "zcc-cua-driver"),
      publish: (event, payload) => zcc.realtime.publish(`cua.${event}`, payload),
      warn: (message) => zcc.log.warn(message),
      threadTitle: async (threadId) => {
        const thread = await zcc.sdk.threads.get({ threadId });
        return thread?.title || thread?.titleFallback || "";
      },
      askApproval: async (threadId, request) => {
        const result = await zcc.ui.requestInput({
          threadId,
          rendererId: APPROVAL_RENDERER_ID,
          title: "Allow Computer Use action?",
          payload: request,
        });
        return approvalDecision(result);
      },
    });

    settingsHandle.onChange((next) => {
      settings = readSettings(next);
      void controller.refreshStatus();
    });

    if (!driver.binary()) zcc.status.needsConfiguration("Set up Cua Driver in Plugins → Computer Use → Configuration: use the included driver or choose an existing path.");

    zcc.background.service("status-poll", () => {
      const refresh = () => controller.refreshStatus().catch((error) => zcc.log.warn(`status refresh failed: ${error.message}`));
      void refresh();
      const timer = setInterval(refresh, POLL_MS);
      return () => clearInterval(timer);
    });

    const release = (reason: string) => (event: unknown) => {
      const threadId = eventThreadId(event);
      if (threadId) void controller.releaseLease(reason, threadId);
    };
    zcc.events.on("thread.idle", release("Thread finished its turn"));
    zcc.events.on("thread.failed", release("Thread failed"));
    for (const name of ["thread.archived", "thread.deleted"] as const) {
      zcc.events.on(name, (event) => {
        const threadId = eventThreadId(event);
        if (!threadId) return;
        void controller.releaseLease("Thread closed", threadId);
        controller.forgetThread(threadId);
      });
    }

    zcc.agents.contributeInstructions(INSTRUCTIONS);

    zcc.agents.registerTool({
      name: "cua_driver",
      description:
        "Call one Cua Driver tool to see or operate a desktop app on the user's macOS or Windows computer, e.g. " +
        '{"tool":"list_apps"}, {"tool":"get_window_state","arguments":{"pid":123,"window_id":456}}, ' +
        '{"tool":"click","arguments":{"pid":123,"window_id":456,"element_token":"s00000001:5"}}. ' +
        "Observe with get_window_state before acting and verify with a fresh snapshot after. Window screenshots come " +
        "back attached as an image (pass include_screenshot:false to skip). The first action takes the shared " +
        "desktop lease for this thread; if another thread holds it you get refusal code desktop_busy. " +
        "Foreground, whole-desktop, clipboard and force-quit actions may ask the user first.",
      parameters: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Cua Driver tool name, e.g. list_apps, get_window_state, click, type_text." },
          arguments: { type: "object", description: "The tool's input object. Use cua_driver_describe for its schema." },
        },
        required: ["tool"],
        additionalProperties: false,
      },
      execute: async (input, ctx) => {
        const { tool, arguments: args } = (input ?? {}) as { tool?: unknown; arguments?: unknown };
        return toToolResult(
          await controller.invoke(
            ctx.threadId,
            typeof tool === "string" ? tool : "",
            args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
          ),
        );
      },
    });

    zcc.agents.registerTool({
      name: "cua_driver_describe",
      description: "List Cua Driver tools, or return one tool's full description and input schema. Never needs the desktop lease.",
      parameters: {
        type: "object",
        properties: { tool: { type: "string", description: "Tool name; omit to list every tool." } },
        additionalProperties: false,
      },
      execute: async (input) => {
        const tool = (input as { tool?: unknown } | undefined)?.tool;
        return toToolResult(await controller.describe(typeof tool === "string" && tool ? tool : undefined));
      },
    });

    zcc.agents.registerTool({
      name: "cua_driver_release",
      description: "Hand the desktop back once your GUI work is done, so the user or another thread can use it.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, ctx) => {
        const released = await controller.releaseLease("Released by the agent", ctx.threadId);
        return JSON.stringify({ released: Boolean(released) });
      },
    });

    const threadArg = (args: unknown) => {
      const threadId = (args as { threadId?: unknown } | undefined)?.threadId;
      if (typeof threadId !== "string" || !threadId) throw new Error("threadId is required");
      return threadId;
    };
    zcc.rpc.method("status", async () => ({
      status: await controller.currentStatus(),
      activity: controller.recentActivity(),
      settings,
      setup: bundled.info(settings.driverSource ?? "automatic"),
    }));
    zcc.rpc.method("prepareIncluded", async () => {
      const path = await bundled.prepare();
      await controller.refreshStatus();
      return { output: `Included Cua Driver is ready at ${path}. Select Included with plugin above, then Start (or Restart) the daemon.` };
    });
    zcc.rpc.method("refresh", () => controller.refreshStatus());
    zcc.rpc.method("thread", (args) => controller.threadState(threadArg(args)));
    zcc.rpc.method("screenshot", (args) => ({ dataUrl: controller.screenshot(threadArg(args)) }));
    // With a threadId (the thread's Desktop tab), only that thread's lease is released.
    zcc.rpc.method("release", async (args) => {
      const threadId = (args as { threadId?: unknown } | undefined)?.threadId;
      return { released: await controller.releaseLease("Released by the user", typeof threadId === "string" && threadId ? threadId : undefined) };
    });
    zcc.rpc.method("start", () => controller.start());
    zcc.rpc.method("stop", () => controller.stop());
    zcc.rpc.method("restart", () => controller.restart());
    zcc.rpc.method("grant", () => controller.grant());
    zcc.rpc.method("telemetry", (args) => controller.setTelemetry((args as { enabled?: unknown } | undefined)?.enabled === true));

    zcc.cli.register({
      name: "cua-driver",
      summary: "Inspect and control the Cua Driver desktop lease and daemon",
      commands: [
        { name: "status", summary: "Show daemon, permission, screen-lock and lease state", usage: "zcc cua-driver status [--json]" },
        { name: "activity", summary: "Show recent agent calls", usage: "zcc cua-driver activity [--json]" },
        { name: "release", summary: "Release the desktop lease", usage: "zcc cua-driver release" },
        { name: "start", summary: "Start the daemon with the configured permission mode", usage: "zcc cua-driver start" },
        { name: "stop", summary: "Stop the daemon", usage: "zcc cua-driver stop" },
        { name: "restart", summary: "Restart the daemon to apply settings", usage: "zcc cua-driver restart" },
      ],
      run: async (argv) => {
        const [command = "status", ...rest] = argv;
        const json = rest.includes("--json");
        try {
          switch (command) {
            case "status": {
              const status = await controller.refreshStatus();
              return { exitCode: 0, stdout: json ? `${JSON.stringify(status, null, 2)}\n` : statusText(status) };
            }
            case "activity": {
              const rows = controller.recentActivity();
              const text = rows
                .map((row) => `${new Date(row.at).toISOString()}  ${row.outcome.padEnd(8)} ${row.tool.padEnd(18)} ${row.threadTitle}: ${row.summary}`)
                .join("\n");
              return { exitCode: 0, stdout: json ? `${JSON.stringify(rows, null, 2)}\n` : `${text || "no activity yet"}\n` };
            }
            case "release": {
              const released = await controller.releaseLease("Released from the CLI");
              return { exitCode: 0, stdout: released ? `released lease held by ${released.title}\n` : "lease was free\n" };
            }
            case "start":
            case "stop":
            case "restart":
              return { exitCode: 0, stdout: statusText(await controller[command]()) };
            default:
              return { exitCode: 2, stderr: `unknown command: ${command}\n` };
          }
        } catch (error) {
          return { exitCode: 1, stderr: `${(error as Error).message}\n` };
        }
      },
    });

    zcc.onDispose(() => controller.releaseLease("Plugin unloaded").then(() => undefined));
    zcc.log.info(`${zcc.pluginId} loaded (binary: ${driver.binary() ?? "not installed"})`);
  };
}

export default createPlugin();
