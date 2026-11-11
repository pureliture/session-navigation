import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Candidate, Reply } from "./context.ts";

interface OverlayActions {
  sessionId(ctx: ExtensionContext): string | null;
  getCandidate(): Candidate | null;
  rpc(method: string, params: object, timeout: number): Promise<Reply>;
  summarizeText(ctx: unknown, content: string): Promise<string | null>;
  manageChosen(params: Record<string, unknown>, ctx: ExtensionContext): Promise<Reply>;
}

export function registerOverlay(
  pi: ExtensionAPI,
  { sessionId, getCandidate, rpc, summarizeText, manageChosen }: OverlayActions,
): void {
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("session-navigation", {
      description: "Open the session navigation panel",
      handler: async (_args: string, ctx: any) => {
        if (ctx?.mode !== "tui") {
          try {
            ctx?.ui?.notify?.("session-navigation requires an interactive TUI", "warning");
          } catch {
            /* ignore */
          }
          try {
            ctx?.abort?.();
          } catch {
            /* ignore */
          }
          return;
        }
        const session = sessionId(ctx);
        await ctx.ui.custom(
          async (tui: any, _theme: any, keybindings: any, done: (result?: unknown) => void) => {
            let rows: any[] = [];
            let selected = 0;
            let notice = "";
            let selectList: any = null;
            const snapshotId = () =>
              getCandidate()?.confirmed && getCandidate()?.session === session
                ? getCandidate()?.token
                : undefined;
            const rebuildSelectList = async () => {
              const items = rows.map((r: any, idx: number) => ({
                value: String(idx),
                label: String(r?.tool_call_id ?? r?.call_id ?? ""),
              }));
              try {
                const mod: any = await import("@oh-my-pi/pi-tui");
                const SL = mod?.SelectList;
                if (!SL) throw new Error("no-select-list");
                const themeObj: any = {
                  selectedPrefix: (x: string) => x,
                  selectedText: (x: string) => x,
                  description: (x: string) => x,
                  scrollInfo: (x: string) => x,
                  noMatch: (x: string) => x,
                  symbols: {},
                };
                selectList = new SL(items, Math.max(1, Math.min(10, items.length || 1)), themeObj, {
                  overflowSearch: false,
                });
                selectList.onSelect = (item: any) => {
                  selected = Number(item?.value ?? 0);
                  tui?.requestRender?.();
                };
                selectList.onCancel = () => done(undefined);
              } catch {
                selectList = null;
              }
            };
            const reload = async () => {
              const res: any = await rpc(
                "list_items",
                { query: "", session_id: session, snapshot_id: snapshotId() },
                5000,
              );
              if (!res?.ok) {
                if (res?.error === "db_error") {
                  const choice = await ctx.ui.select(
                    "Database error",
                    Array.isArray(res?.choices) ? res.choices : ["abort_request", "send_original"],
                  );
                  if (choice === "abort_request") {
                    ctx.abort?.();
                    done(undefined);
                    return;
                  }
                  notice = "send_original";
                } else {
                  notice = String(res?.error ?? "list_failed");
                }
                rows = [];
              } else {
                rows = Array.isArray(res?.items) ? res.items : [];
                if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
              }
              await rebuildSelectList();
              tui?.requestRender?.();
            };
            const finishMutation = async (res: any) => {
              if (!res?.ok) {
                if (res?.error === "version_conflict") {
                  notice = "version_conflict";
                  await reload();
                  return;
                }
                if (res?.error === "db_error") {
                  const choice = await ctx.ui.select(
                    "Database error",
                    Array.isArray(res?.choices) ? res.choices : ["abort_request", "send_original"],
                  );
                  if (choice === "abort_request") {
                    ctx.abort?.();
                    done(undefined);
                    return;
                  }
                  notice = "send_original";
                  await reload();
                  return;
                }
                if (res?.error === "summarizer_unavailable") {
                  notice = "summarizer_unavailable";
                  tui?.requestRender?.();
                  return;
                }
                notice = String(res?.error ?? "failed");
                tui?.requestRender?.();
                return;
              }
              notice = "";
              await reload();
            };
            const hideSelected = async () => {
              const row = rows[selected];
              if (!row) return;
              const toolCallId = row?.tool_call_id ?? row?.call_id;
              await finishMutation(
                await rpc(
                  "compact",
                  { tool_call_id: toolCallId, session_id: session, snapshot_id: snapshotId() },
                  5000,
                ),
              );
            };
            const summarizeSelected = async () => {
              const snapshot = getCandidate();
              const row = rows[selected];
              if (!row) return;
              const toolCallId = row?.tool_call_id ?? row?.call_id;
              const target = getCandidate()?.records?.find((r: any) => r?.call_id === toolCallId);
              let summary: string | null;
              try {
                summary = target ? await summarizeText(ctx, target.content) : null;
              } catch (error) {
                notice = (error as { reason?: string })?.reason ?? "summarizer_unavailable";
                tui?.requestRender?.();
                return;
              }
              if (getCandidate() !== snapshot) {
                notice = "unconfirmed_snapshot";
                tui?.requestRender?.();
                return;
              }
              if (!summary) {
                notice = "summarizer_unavailable";
                tui?.requestRender?.();
                return;
              }
              await finishMutation(
                await rpc(
                  "summarize",
                  {
                    tool_call_id: toolCallId,
                    summary_text: summary,
                    session_id: session,
                    snapshot_id: snapshotId(),
                  },
                  25000,
                ),
              );
            };
            const unhideSelected = async () => {
              const row = rows[selected];
              if (!row?.item_id) return;
              await finishMutation(
                await rpc(
                  "restore",
                  {
                    item_id: row.item_id,
                    expected_version: row.version,
                    session_id: session,
                    snapshot_id: snapshotId(),
                  },
                  5000,
                ),
              );
            };
            const rehideSelected = async () => {
              await hideSelected();
            };
            const manageSelected = async () => {
              const id = rows[selected]?.tool_call_id ?? rows[selected]?.call_id;
              const res = await manageChosen(
                { action: "auto", tool_call_ids: id ? [id] : [] },
                ctx,
              );
              await finishMutation(res);
            };
            await reload();
            const component: any = {
              render: (_width: number) => {
                const lines: string[] = [];
                lines.push("Session navigation");
                if (notice) lines.push(notice);
                if (rows.length === 0) lines.push("(no rows)");
                rows.forEach((r: any, idx: number) => {
                  const prefix = idx === selected ? "> " : "  ";
                  lines.push(
                    prefix +
                      String(r?.status ?? "") +
                      " " +
                      String(r?.tool_call_id ?? r?.call_id ?? "") +
                      " tokens:" +
                      String(r?.tokens_display ?? "—") +
                      " v" +
                      String(r?.version ?? ""),
                  );
                });
                lines.push("[h]ide [s]ummarize [u]nhide [r]e-hide [m]anage selected [Esc] close");
                return lines;
              },
              handleInput: async (data: string) => {
                let matchesKeyFn: any = null;
                try {
                  const mod: any = await import("@oh-my-pi/pi-tui");
                  matchesKeyFn = mod?.matchesKey;
                } catch {
                  /* ignore */
                }
                try {
                  if (keybindings?.matches?.(data, "app.interrupt")) {
                    done(undefined);
                    return;
                  }
                } catch {
                  /* ignore */
                }
                if (matchesKeyFn && matchesKeyFn(data, "escape")) {
                  done(undefined);
                  return;
                }
                if (matchesKeyFn && matchesKeyFn(data, "up")) {
                  selected = Math.max(0, selected - 1);
                  tui?.requestRender?.();
                  return;
                }
                if (matchesKeyFn && matchesKeyFn(data, "down")) {
                  selected = Math.min(Math.max(0, rows.length - 1), selected + 1);
                  tui?.requestRender?.();
                  return;
                }
                const key = String(data ?? "").toLowerCase();
                if (key === "h") {
                  void hideSelected();
                  return;
                }
                if (key === "s") {
                  void summarizeSelected();
                  return;
                }
                if (key === "u") {
                  void unhideSelected();
                  return;
                }
                if (key === "r") {
                  void rehideSelected();
                  return;
                }
                if (key === "m") {
                  void manageSelected();
                  return;
                }
                if (selectList && typeof selectList.handleInput === "function") {
                  try {
                    selectList.handleInput(data);
                  } catch {
                    /* ignore */
                  }
                }
              },
              invalidate: () => {
                try {
                  selectList?.invalidate?.();
                } catch {
                  /* ignore */
                }
              },
            };
            return component;
          },
          { overlay: true },
        );
      },
    });
  }
}
