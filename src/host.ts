import { readFileSync, statSync } from "node:fs";
import type { ApprovalDecision } from "./controller.ts";

/** Thread id from a lifecycle event; hosts send `{ threadId }`, `{ thread }`, or both. */
export function eventThreadId(event: unknown): string | null {
  const value = event as { threadId?: unknown; thread?: { id?: unknown } } | null | undefined;
  const id = value?.threadId ?? value?.thread?.id;
  return typeof id === "string" && id ? id : null;
}

/**
 * Approval choice from `ui.requestInput`. Newer hosts wrap the submitted value
 * in `{ outcome, value }`; anything that is not an explicit allow is a deny.
 */
export function approvalDecision(result: unknown): ApprovalDecision {
  const envelope = result as { outcome?: unknown; value?: unknown } | null | undefined;
  const value = envelope && typeof envelope === "object" && "outcome" in envelope
    ? envelope.outcome === "submitted" ? envelope.value : undefined
    : result;
  const decision = (value as { decision?: unknown } | null | undefined)?.decision;
  return decision === "allow-once" || decision === "allow-thread" ? decision : "deny";
}

/** Largest screenshot attached inline to a tool result; larger ones stay on disk. */
export const MAX_INLINE_IMAGE_BYTES = 3_000_000;

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Agent tool result: the JSON body as text, plus the saved screenshot when small enough. */
export function toToolResult(body: Record<string, unknown>): { content: ToolContent[]; isError?: boolean } {
  const content: ToolContent[] = [{ type: "text", text: JSON.stringify(body) }];
  const path = body.screenshot_file_path;
  if (typeof path === "string") {
    try {
      if (statSync(path).size <= MAX_INLINE_IMAGE_BYTES) {
        content.push({
          type: "image",
          data: readFileSync(path).toString("base64"),
          mimeType: path.endsWith(".jpg") || path.endsWith(".jpeg") ? "image/jpeg" : "image/png",
        });
      }
    } catch {
      // The path is still in the text body; a missing file is not a tool failure.
    }
  }
  const failed = body.status === "refused" || body.status === "error";
  return failed ? { content, isError: true } : { content };
}
