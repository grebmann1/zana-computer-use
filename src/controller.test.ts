import { describe, expect, it } from "vitest";
import { Controller, DEFAULT_SETTINGS, fitResult } from "./controller.ts";
import { FakeDriver } from "../test/fake-driver.ts";

it("Windows readiness does not depend on macOS privacy grants", async () => {
  const driver = new FakeDriver();
  driver.perms = { accessibility: null, screenRecording: null };
  const controller = new Controller({
    platform: "win32", driver, settings: () => DEFAULT_SETTINGS,
    threadTitle: async () => "Test", askApproval: async () => "deny",
    publish: () => {}, warn: () => {}, screenshotDir: "/unused",
  });
  expect(await controller.refreshStatus()).toMatchObject({ platform: "win32", state: "ready" });
  driver.locked = true;
  expect(await controller.refreshStatus()).toMatchObject({ state: "locked" });
});

describe("fitResult", () => {
  it("returns small results unchanged", () => {
    expect(fitResult({ status: "ok", apps: [1, 2] })).toEqual({ status: "ok", apps: [1, 2] });
  });

  it("trims any large list, not just elements, and says so", () => {
    const apps = Array.from({ length: 200 }, (_, i) => ({ name: `App ${i}`, bundle_id: `com.example.app${i}`, running: i < 20 }));
    const fitted = fitResult({ apps }, 2_000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(2_000);
    expect((fitted.apps as unknown[]).length).toBeGreaterThan(0);
    expect(fitted.zcc_truncated).toMatch(/^apps truncated to \d+ of 200\. Narrow the request/);
  });

  it("drops tree_markdown before cutting elements", () => {
    const elements = Array.from({ length: 5 }, (_, i) => ({ element_index: i }));
    const fitted = fitResult({ elements, tree_markdown: "x".repeat(3_000) }, 1_000);
    expect(fitted).toMatchObject({ elements, zcc_truncated: expect.stringContaining("tree_markdown dropped") });
    expect(fitted.tree_markdown).toBeUndefined();
  });
});
