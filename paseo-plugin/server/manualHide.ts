import type { Item, RecordInput } from "../../packages/core/src/model.ts";

/**
 * Manual hide is a separate operation from engine compaction.
 *
 * It performs no policy evaluation (refusal reasons, compaction rules, excerpt
 * selection). The user explicitly asked to hide the row, so the replacement is
 * a single line and the original output is kept only for the preview/unhide
 * path. The invocation snapshot is intentionally not stored: the refusal
 * reasons that guard it (`sensitive_invocation`, `invocation_too_large`) are
 * about persistence, and manual hide must not bypass them by writing it.
 */
export const MANUAL_HIDE_SOURCE = "explicit_user_hide";

export function manualHideReplacement(
  record: Pick<RecordInput, "call_id" | "invocation">,
): string {
  const tool = String(record.invocation?.tool_name ?? "tool");
  return `[hidden: ${tool} ${record.call_id}]`;
}

export function manualHideItem(itemId: string, record: RecordInput): Item {
  return {
    item_id: itemId,
    tool_call_id: record.call_id,
    result_position: record.result_position,
    content_sha256: record.content_sha256,
    invocation_digest: record.invocation_digest,
    original: record.content,
    compacted: manualHideReplacement(record),
    excerpt_lines: [],
    visibility: "hidden",
    version: 1,
    tool_name: String(record.invocation.tool_name),
    compaction_source: MANUAL_HIDE_SOURCE,
    invocation_snapshot: null,
    context_hint: null,
    invocation_options_omitted: false,
    created_at: 0,
    updated_at: 0,
  };
}
