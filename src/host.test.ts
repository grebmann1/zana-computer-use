import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_INLINE_IMAGE_BYTES, approvalDecision, eventThreadId, toToolResult } from "./host.ts";

describe("eventThreadId", () => {
  it("accepts both lifecycle event shapes", () => {
    expect(eventThreadId({ name: "thread.idle", threadId: "t1" })).toBe("t1");
    expect(eventThreadId({ thread: { id: "t2" } })).toBe("t2");
    expect(eventThreadId({})).toBeNull();
    expect(eventThreadId(undefined)).toBeNull();
  });
});

describe("approvalDecision", () => {
  it("reads the submitted decision from either result shape", () => {
    expect(approvalDecision({ outcome: "submitted", value: { decision: "allow-thread" } })).toBe("allow-thread");
    expect(approvalDecision({ decision: "allow-once" })).toBe("allow-once");
  });

  it("treats cancellation, timeouts and anything unexpected as deny", () => {
    expect(approvalDecision({ outcome: "cancelled", reason: "timeout" })).toBe("deny");
    expect(approvalDecision({ outcome: "submitted", value: { decision: "yes" } })).toBe("deny");
    expect(approvalDecision(null)).toBe("deny");
  });
});

describe("toToolResult", () => {
  it("returns the JSON body and attaches the screenshot", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cua-test-")), "shot.png");
    writeFileSync(path, "png");
    const result = toToolResult({ status: "ok", screenshot_file_path: path });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ status: "ok", screenshot_file_path: path }) },
      { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("leaves large or missing screenshots on disk", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cua-test-")), "big.jpg");
    writeFileSync(path, Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1));
    expect(toToolResult({ status: "ok", screenshot_file_path: path }).content).toHaveLength(1);
    expect(toToolResult({ status: "ok", screenshot_file_path: "/nope.png" }).content).toHaveLength(1);
  });

  it("flags refusals as tool errors", () => {
    expect(toToolResult({ status: "refused", refusal: { code: "desktop_busy" } }).isError).toBe(true);
  });
});
