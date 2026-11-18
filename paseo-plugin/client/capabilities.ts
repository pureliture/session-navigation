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

export function isManagedAdapterProvider(
  provider?: string | null,
  scopeKey?: string | null,
): boolean {
  if (typeof scopeKey === "string" && scopeKey) {
    const prefix = scopeKey.split(":")[0]?.toLowerCase() ?? "";
    return prefix === "omp" || prefix === "hermes" || prefix === "pi";
  }
  if (typeof provider === "string" && provider.trim()) {
    const normalized = provider.trim().toLowerCase();
    return (
      normalized === "omp" ||
      normalized === "pi" ||
      normalized === "acp" ||
      normalized === "hermes" ||
      /^hermes[-_:]/u.test(normalized)
    );
  }
  return true;
}

export function capabilityNotice(
  error?: string,
  capabilities?: Capabilities,
  options?: { provider?: string | null; scopeKey?: string | null; rowCount?: number },
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
    return "Context management paused in settings — existing hidden items stay protected.";
  if (!capabilities || capabilities.state === "adapter_not_detected") {
    if (!isManagedAdapterProvider(options?.provider, options?.scopeKey)) return null;
    if (options?.rowCount === 0 && (!options?.scopeKey || !capabilities || capabilities.state === "adapter_not_detected")) {
      return null;
    }
    return (
      capabilities?.hint ??
      "Adapter not detected. Install and enable the Session Navigation adapter in the session host. History and existing hidden items remain available."
    );
  }
  return null;
}
