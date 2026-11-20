import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export {
  DEFAULT_OUTLINE_SETTINGS,
  outlineSettings,
  outlineSettingsSchema,
  type OutlineSettingsValues,
} from "./outlineSettings";

export const StatusSchema = z.enum(["hidden", "visible", "unhidden"]);

export const CapabilitiesSchema = z.object({
  display: z.boolean(),
  hide: z.boolean(),
  summarize: z.boolean(),
  unhide: z.boolean(),
  state: z.enum([
    "ready",
    "adapter_not_detected",
    "incompatible_protocol",
    "adapter_disabled",
  ]),
  hint: z.string().optional(),
});

export const RowSchema = z.object({
  item_id: z.string().nullable(),
  tool_call_id: z.string(),
  tool_name: z.string().nullable().optional(),
  kind: z.enum(["user", "assistant", "agent", "tool"]).optional(),
  status: StatusSchema,
  visibility: z.enum(["hidden", "visible"]).optional(),
  version: z.number().int(),
  tokens_display: z.string(),
  tokens: z.number().optional(),
  manageable: z.boolean().optional(),
  cost_usd: z.number().nullable().optional(),
  source: z.string().optional(),
  bytes_size: z.number().optional(),
  compacted_bytes_size: z.number().optional(),
  summary_line: z.string().optional(),
  tool_input: z.string().optional(),
  tool_output: z.string().optional(),
  message_text: z.string().optional(),
  replacement_text: z.string().optional(),
  summary_pending: z.boolean().optional(),
  timeline_index: z.number().int().nonnegative().optional(),
});

export const DbErrorChoicesSchema = z.array(
  z.enum(["abort_request", "send_original"]),
);

export const DbErrorSchema = z.object({
  ok: z.literal(false),
  error: z.literal("db_error"),
  choices: DbErrorChoicesSchema,
});

export const VersionConflictSchema = z.object({
  ok: z.literal(false),
  error: z.literal("version_conflict"),
  item: RowSchema.nullable().optional(),
});

export const MutationResultSchema = z.object({
  ok: z.boolean(),
  item_id: z.string().nullable().optional(),
  status: StatusSchema.optional(),
  visibility: z.enum(["hidden", "visible"]).optional(),
  version: z.number().int().nullable().optional(),
  error: z.string().optional(),
  item: RowSchema.optional(),
  choices: z.array(z.string()).optional(),
});

export const PerItemResultSchema = z.object({
  tool_call_id: z.string(),
  ok: z.boolean(),
  item_id: z.string().nullable().optional(),
  error: z.string().optional(),
});

export const ManageResultSchema = z.object({
  ok: z.boolean(),
  applied: z.number().int(),
  failed: z.number().int(),
  items: z.array(PerItemResultSchema),
  error: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

export const ListTotalsSchema = z.object({
  total_rows: z.number().int(),
  manageable_count: z.number().int(),
  hidden_count: z.number().int(),
  saved_bytes: z.number(),
});

export const ListResultSchema = z.object({
  ok: z.boolean(),
  // B5: the service echoes the requested (parent) scope_key for API
  // compatibility; the schema must not strip it.
  scope_key: z.string().optional(),
  items: z.array(RowSchema),
  capabilities: CapabilitiesSchema.optional(),
  context: z
    .object({
      used_tokens: z.number(),
      max_tokens: z.number().nullable().optional(),
      source: z.string().optional(),
    })
    .optional(),
  server_timeline: z.boolean().optional(),
  // B10: paused adapter state (P1-7 parity). Additive: ready scopes omit both.
  paused: z.boolean().optional(),
  paused_warning: z.string().optional(),
  records_capped: z.boolean().optional(),
  timeline_read_error: z.string().optional(),
  has_older: z.boolean().optional(),
  next_before_index: z.number().int().nonnegative().nullable().optional(),
  totals: ListTotalsSchema.optional(),
  error: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

export const ForkScopeResultSchema = z.object({
  ok: z.boolean(),
  counts: z.record(z.string(), z.number()).optional(),
  error: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

export const DbChoiceResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export const ScopesResultSchema = z.object({
  ok: z.boolean(),
  scopes: z.array(
    z.object({
      scope_key: z.string(),
      parent_scope: z.string().nullable().optional(),
      tool_call_id: z.string().nullable().optional(),
      subagent_id: z.string().nullable().optional(),
      items: z.number().int(),
      agent_id: z.string().optional(),
      capabilities: CapabilitiesSchema.optional(),
    }),
  ),
  error: z.string().optional(),
});

export const listScopesRpc = defineRpc({
  name: "session-nav.scopes",
  input: z.object({ parent_scope: z.string().optional() }),
  output: ScopesResultSchema,
});

export const listItemsRpc = defineRpc({
  name: "session-nav.list",
  input: z.object({
    scope_key: z.string(),
    query: z.string().optional(),
    snapshot_id: z.string().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
    before_index: z.number().int().nonnegative().optional(),
  }),
  output: ListResultSchema,
});

export const hideItemRpc = defineRpc({
  name: "session-nav.hide",
  input: z.object({
    scope_key: z.string(),
    item_id: z.string(),
    expected_version: z.number().int().optional(),
    mode: z.enum(["hide", "summarize"]).optional(),
  }),
  output: MutationResultSchema,
});

export const unhideItemRpc = defineRpc({
  name: "session-nav.unhide",
  input: z.object({
    scope_key: z.string(),
    item_id: z.string(),
    expected_version: z.number().int().optional(),
  }),
  output: MutationResultSchema,
});

export const BatchItemSchema = z.object({
  item_id: z.string().min(1),
  expected_version: z.number().int().optional(),
});

export const BatchMutationResultSchema = z.object({
  ok: z.boolean(),
  applied: z.number().int(),
  failed: z.number().int(),
  items: z.array(
    z.object({
      item_id: z.string(),
      ok: z.boolean(),
      status: StatusSchema.nullable(),
      visibility: z.enum(["hidden", "visible"]).nullable(),
      version: z.number().int().nullable(),
      error: z.string().optional(),
    }),
  ),
  error: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

export const hideBatchRpc = defineRpc({
  name: "session-nav.hide-batch",
  input: z.object({
    scope_key: z.string(),
    mode: z.enum(["hide", "summarize"]).optional(),
    items: z.array(BatchItemSchema),
  }),
  output: BatchMutationResultSchema,
});

export const unhideBatchRpc = defineRpc({
  name: "session-nav.unhide-batch",
  input: z.object({
    scope_key: z.string(),
    items: z.array(BatchItemSchema),
  }),
  output: BatchMutationResultSchema,
});

export const summarizeItemRpc = defineRpc({
  name: "session-nav.summarize",
  input: z.object({
    scope_key: z.string(),
    item_id: z.string(),
    expected_version: z.number().int().optional(),
    summary_text: z.string().optional(),
  }),
  output: MutationResultSchema,
});

export const manageItemsRpc = defineRpc({
  name: "session-nav.manage",
  input: z.object({
    scope_key: z.string(),
    action: z.enum(["auto", "hide", "summarize"]).optional(),
    max_items: z.number().int().min(1).max(64).optional(),
    snapshot_id: z.string().optional(),
    tool_call_ids: z.array(z.string()).optional(),
    summaries: z.record(z.string(), z.string()).optional(),
  }),
  output: ManageResultSchema,
});

export const forkScopeRpc = defineRpc({
  name: "session-nav.fork-scope",
  input: z.object({
    src_scope_key: z.string(),
    dst_scope_key: z.string(),
  }),
  output: ForkScopeResultSchema,
});

export const dbChoiceRpc = defineRpc({
  name: "session-nav.db.choice",
  input: z.object({
    // B5: the server requires a 4-segment scope_key (invalid_scope
    // otherwise), so the schema requires it too instead of silently
    // accepting calls that can never succeed.
    scope_key: z.string(),
    choice: z.enum(["abort_request", "send_original"]),
  }),
  output: DbChoiceResultSchema,
});

export const OmpAdapterToggleSchema = z.object({
  installed: z.boolean(),
  enabled: z.boolean(),
  statusText: z.string().optional(),
  error: z.string().optional(),
});

export const HermesProfileToggleStateSchema = z.object({
  profile: z.string(),
  configPath: z.string(),
  enabled: z.boolean(),
});

export const HermesAdapterToggleSchema = z.object({
  installed: z.boolean(),
  enabled: z.boolean(),
  profileCount: z.number().int().nonnegative(),
  enabledProfileCount: z.number().int().nonnegative().optional(),
  mixed: z.boolean().optional(),
  stateUnknown: z.boolean().optional(),
  canDisable: z.boolean().optional(),
  protectionVerified: z.boolean().optional(),
  pluginInstalled: z.boolean().optional(),
  protectionSupportedOnDisk: z.boolean().optional(),
  unverifiedScopes: z.array(z.string()).optional(),
  profiles: z.array(HermesProfileToggleStateSchema).optional(),
  rolledBack: z.boolean().optional(),
  partialUpdate: z.boolean().optional(),
  updatedFiles: z.array(z.string()).optional(),
  rolledBackFiles: z.array(z.string()).optional(),
  rollbackFailedFiles: z.array(z.string()).optional(),
  statusText: z.string().optional(),
  warning: z.string().optional(),
  remediation: z.string().optional(),
  error: z.string().optional(),
});

export const AdapterTogglesResultSchema = z.object({
  ok: z.boolean(),
  omp: OmpAdapterToggleSchema,
  hermes: HermesAdapterToggleSchema,
  error: z.string().optional(),
});

export const getAdapterTogglesRpc = defineRpc({
  name: "session-nav.get-adapter-toggles",
  input: z.object({}),
  output: AdapterTogglesResultSchema,
});

export const setAdapterToggleRpc = defineRpc({
  name: "session-nav.set-adapter-toggle",
  input: z.object({
    adapter: z.enum(["omp", "hermes"]),
    enabled: z.boolean(),
  }),
  output: AdapterTogglesResultSchema,
});

export type AdapterTogglesResult = z.infer<typeof AdapterTogglesResultSchema>;

export interface ScopeContext {
  adapterId?: string;
  hostProfile?: string;
  sessionId: string;
  branchScope?: string;
}

export function deriveScopeKey(ctx: ScopeContext): string {
  const adapterId = ctx.adapterId ?? "paseo";
  const hostProfile = ctx.hostProfile ?? "default";
  const branchScope = ctx.branchScope ?? "default";
  return `${adapterId}:${hostProfile}:${ctx.sessionId}:${branchScope}`;
}

export function scopeKeyFromWorkspace(
  workspaceId: string,
  agentId?: string | null,
): string {
  return deriveScopeKey({
    adapterId: "paseo",
    hostProfile: "default",
    sessionId: agentId ?? workspaceId,
    branchScope: "default",
  });
}
// Cross-source compaction-summary identity (P1-3 contract, dependency-free
// implementation so the worker bundle stays lean).
export { summaryDedupeKey } from "./summaryDedupe";
export type Row = z.infer<typeof RowSchema>;
