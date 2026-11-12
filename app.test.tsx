// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { collectTestPluginApp, renderSlot } from "@zana-ai/zcc-plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import definition from "./app.tsx";
import type { Status } from "./src/controller.ts";

const app = collectTestPluginApp(definition, "cua-driver-test") as ReturnType<typeof collectTestPluginApp> & {
  settingsSections: Array<{ id: string; component: unknown }>;
  projectStatusbarItems: Array<{ id: string; item: unknown }>;
  threadPanelActions: Array<{ id: string; title: string; component: unknown }>;
  pendingInteractions: Array<{ id: string; component: unknown }>;
};

function status(overrides: Partial<Status> = {}): Status {
  return {
    state: "ready",
    label: "Ready",
    binary: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    version: "0.33.3",
    daemon: { running: true, pid: 42, permissionMode: "standard" },
    permissions: { accessibility: true, screenRecording: true },
    screenLocked: false,
    telemetry: true,
    lease: null,
    warnings: [],
    checkedAt: 1,
    ...overrides,
  };
}

const settings = { permissionMode: "standard", leaseIdleMinutes: 10, autoStart: true, requireApproval: true };
const lease = { threadId: "t1", title: "Fix the report", acquiredAt: Date.now(), lastUsedAt: Date.now() };

afterEach(() => cleanup());

describe("Computer Use app", () => {
  it("registers plugin settings, status chip, thread tab and approval renderer without a sidebar entry", () => {
    expect(app.navPanels).toEqual([]);
    expect(app.settingsSections.map((section) => section.id)).toEqual(["desktop"]);
    expect(app.projectStatusbarItems.map((item) => item.id)).toEqual(["desktop"]);
    expect(app.threadPanelActions.map((action) => action.title)).toEqual(["Desktop"]);
    expect(app.pendingInteractions.map((renderer) => renderer.id)).toEqual(["cua-driver-approval"]);
  });

  it("shows daemon, permissions and the lease, and releases it", async () => {
    const release = vi.fn(() => ({ released: lease }));
    const view = renderSlot(
      app.settingsSections[0]!,
      { pluginId: "cua-driver-test" },
      { rpc: { status: () => ({ status: status({ state: "busy", label: "In use by Fix the report", lease }), activity: [], settings }), release } },
    );
    await view.findByText("In use by Fix the report");
    expect(view.getByText(/running \(pid 42, standard mode\)/)).toBeTruthy();
    expect(view.getAllByText("granted")).toHaveLength(2);
    fireEvent.click(view.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(release).toHaveBeenCalled());
  });

  it("shows the install command when Cua Driver is missing", async () => {
    const view = renderSlot(
      app.settingsSections[0]!,
      { pluginId: "cua-driver-test" },
      { rpc: { status: () => ({ status: status({ state: "not-installed", label: "Not installed", binary: null }), activity: [], settings }) } },
    );
    await view.findByText("The selected Cua Driver is not available");
    expect(view.getByText(/cua\.ai\/driver\/install\.sh/)).toBeTruthy();
  });

  it("toggles Cua Driver telemetry", async () => {
    const telemetry = vi.fn(() => status({ telemetry: false }));
    const view = renderSlot(
      app.settingsSections[0]!,
      { pluginId: "cua-driver-test" },
      { rpc: { status: () => ({ status: status(), activity: [], settings }), telemetry } },
    );
    fireEvent.click(await view.findByRole("button", { name: "Disable" }));
    await waitFor(() => expect(telemetry).toHaveBeenCalledWith({ enabled: false }));
  });

  it("offers offline setup and switches between macOS and Windows guidance", async () => {
    const prepareIncluded = vi.fn(() => ({ output: "Included driver is ready." }));
    const view = renderSlot(app.settingsSections[0]!, { pluginId: "cua-driver-test" }, { rpc: {
      status: () => ({ status: status(), activity: [], settings, setup: {
        platform: "darwin", source: "automatic", includedVersion: "0.33.4", includedAvailable: true,
        includedReady: false, includedPath: "/private/CuaDriver.app/Contents/MacOS/cua-driver",
        releaseUrl: "https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.4",
      } }), prepareIncluded,
    } });
    fireEvent.click(await view.findByRole("button", { name: "Set up included Cua Driver 0.33.4" }));
    await view.findByText("Included driver is ready.");
    expect(prepareIncluded).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Windows guide" }));
    expect(view.getByText("Use your interactive Windows desktop")).toBeTruthy();
    expect(view.getByText(/cua\.ai\/driver\/install\.ps1/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "macOS guide" }));
    expect(view.getByText("Grant macOS permissions")).toBeTruthy();
  });

  it("shows Windows status without macOS permission requirements", async () => {
    const view = renderSlot(app.settingsSections[0]!, { pluginId: "cua-driver-test" }, { rpc: {
      status: () => ({ status: status({ platform: "win32", permissions: { accessibility: null, screenRecording: null } }), activity: [], settings }),
    } });
    await view.findByText("Windows desktop");
    expect(view.queryByText("macOS permissions")).toBeNull();
    expect(view.getByRole("button", { name: "Restart" })).toBeTruthy();
  });

  it("status chip follows realtime status and offers state-specific actions", async () => {
    const openMenu = vi.fn(() => true);
    const start = vi.fn(() => status());
    const view = renderSlot(
      { component: app.projectStatusbarItems[0]!.item },
      { pluginId: "cua-driver-test", projectId: "p1", openMenu },
      { rpc: { status: () => ({ status: status({ state: "stopped", label: "Stopped", daemon: { running: false, pid: null, permissionMode: null } }), activity: [], settings }), start } },
    );
    fireEvent.click(await view.findByRole("button", { name: "Computer Use: Stopped" }));
    const items = (openMenu.mock.calls[0] as unknown as [Array<{ label: string; run: () => void }>])[0];
    expect(items.map((item) => item.label)).toEqual(["Start daemon"]);
    items[0]!.run();
    await waitFor(() => expect(start).toHaveBeenCalled());

    act(() => view.emitRealtime("cua.status", status({ state: "locked", label: "Screen locked" })));
    expect(view.getByRole("button", { name: "Computer Use: Screen locked" })).toBeTruthy();
  });

  it("thread tab shows this thread's lease, screenshot and activity", async () => {
    const at = Date.now();
    const view = renderSlot(
      app.threadPanelActions[0]!,
      { pluginId: "cua-driver-test", threadId: "t1" },
      {
        rpc: {
          thread: () => ({
            holdsLease: true,
            lease,
            activity: [{ id: 1, at, threadId: "t1", threadTitle: "Fix the report", tool: "click", outcome: "ok", summary: "Clicked Save", durationMs: 120 }],
            screenshot: { tool: "get_window_state", at },
          }),
          screenshot: () => ({ dataUrl: "data:image/png;base64,AAAA" }),
        },
      },
    );
    await view.findByText("This thread controls the desktop.");
    expect(((await view.findByRole("img")) as HTMLImageElement).src).toBe("data:image/png;base64,AAAA");
    expect(view.getByText("Clicked Save")).toBeTruthy();
  });

  it("approval renderer submits the user's decision", async () => {
    const submit = vi.fn(async () => undefined);
    const view = renderSlot(app.pendingInteractions[0]!, {
      interaction: {
        id: "i1",
        threadId: "t1",
        title: "Allow Computer Use action?",
        payload: { tool: "bring_to_front", keys: ["foreground"], reason: "bring an app to the front, taking focus away from you", threadTitle: "Fix the report", args: '{"pid":7}' },
        createdAt: 0,
        expiresAt: null,
      },
      submit,
      cancel: vi.fn(),
    });
    await view.findByText(/bring an app to the front/);
    fireEvent.click(view.getByRole("button", { name: "Allow for this thread" }));
    expect(submit).toHaveBeenCalledWith({ decision: "allow-thread" });
    fireEvent.click(view.getByRole("button", { name: "Deny" }));
    expect(submit).toHaveBeenLastCalledWith({ decision: "deny" });
  });
});
