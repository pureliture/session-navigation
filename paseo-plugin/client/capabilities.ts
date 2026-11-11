import type { z } from "zod";
import type { CapabilitiesSchema, Row } from "../shared/sessionNav";

export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export function actionAllowed(
  row: Row,
  capabilities: Capabilities | undefined,
  action: "hide" | "summarize" | "unhide",
): boolean {
  if (!row.item_id) return false;
  if (action === "unhide") return row.status === "hidden";
  return (
    !!capabilities?.[action] &&
    row.manageable !== false &&
    (action !== "summarize" || row.kind === "tool")
  );
}

export function capabilityNotice(
  error?: string,
  capabilities?: Capabilities,
): string | null {
  if (error === "runtime_unsupported")
    return "Session Navigation requires Node >=22.13. Upgrade the Paseo daemon runtime.";
  if (["db_error", "db_full", "unsafe_journal_mode"].includes(error ?? ""))
    return "Database error: session state is unavailable. Refresh the outline before retrying.";
  if (
    error === "engine_protocol_incompatible" ||
    capabilities?.state === "incompatible_protocol"
  )
    return "Incompatible adapter/engine protocol. Update Session Navigation and the host adapter.";
  if (error)
    return `Engine/runtime error: ${error}. Refresh the outline before retrying.`;
  if (capabilities?.state === "adapter_disabled")
    return "The session adapter is disabled. Enable it in the session host to hide or summarize.";
  if (!capabilities || capabilities.state === "adapter_not_detected")
    return (
      capabilities?.hint ??
      "Adapter not detected. Install and enable the Session Navigation adapter in the session host. History and existing hidden items remain available."
    );
  return null;
}
