import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, Text, View } from "react-native";
import {
  dbChoiceRpc,
  hideItemRpc,
  listItemsRpc,
  listScopesRpc,
  manageItemsRpc,
  scopeKeyFromWorkspace,
  summarizeItemRpc,
  unhideItemRpc,
  type Row,
} from "../shared/sessionNav";


export function SessionNavPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const queryClient = useQueryClient();
  const defaultScope = scopeKeyFromWorkspace(workspaceId);
  const [scopeKey, setScopeKey] = useState(defaultScope);
  const listRpc = useRpc(listItemsRpc);
  const scopesRpc = useRpc(listScopesRpc);
  const hideRpc = useRpc(hideItemRpc);
  const unhideRpc = useRpc(unhideItemRpc);
  const summarizeRpc = useRpc(summarizeItemRpc);
  const manageRpc = useRpc(manageItemsRpc);
  const dbChoice = useRpc(dbChoiceRpc);

  const [dbErrorOpen, setDbErrorOpen] = useState(false);
  const [notice, setNotice] = useState(null as string | null);
  const [scopeOpen, setScopeOpen] = useState(false);

  const scopesQuery = useQuery({
    queryKey: ["session-nav", "scopes"],
    queryFn: async () => {
      const result = await scopesRpc({});
      if (!result.ok) throw new Error(result.error ?? "scopes_failed");
      return result.scopes;
    },
  });

  const queryKey = useMemo(() => ["session-nav", "list", scopeKey], [scopeKey]);

  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await listRpc({ scope_key: scopeKey });
      if (!result.ok) {
        if (result.error === "db_error") setDbErrorOpen(true);
        throw new Error(result.error ?? "list_failed");
      }
      return result.items;
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const hideMutation = useMutation({
    mutationFn: (row: Row) =>
      hideRpc({ scope_key: scopeKey, item_id: row.item_id ?? "", expected_version: row.version }),
    onSuccess: (result) => {
      if (!result.ok && result.error === "version_conflict") {
        setNotice("version_conflict");
        invalidate();
        return;
      }
      if (!result.ok && result.error === "db_error") {
        setDbErrorOpen(true);
        return;
      }
      invalidate();
    },
  });

  const unhideMutation = useMutation({
    mutationFn: (row: Row) =>
      unhideRpc({ scope_key: scopeKey, item_id: row.item_id ?? "", expected_version: row.version }),
    onSuccess: (result) => {
      if (!result.ok && result.error === "version_conflict") {
        setNotice("version_conflict");
        invalidate();
        return;
      }
      if (!result.ok && result.error === "db_error") {
        setDbErrorOpen(true);
        return;
      }
      invalidate();
    },
  });

  const summarizeMutation = useMutation({
    mutationFn: (row: Row) =>
      summarizeRpc({ scope_key: scopeKey, item_id: row.item_id ?? "", expected_version: row.version }),
    onSuccess: (result) => {
      if (!result.ok && result.error === "version_conflict") {
        setNotice("version_conflict");
        invalidate();
        return;
      }
      if (!result.ok && result.error === "db_error") {
        setDbErrorOpen(true);
        return;
      }
      if (!result.ok && result.error === "summarizer_unavailable") {
        setNotice("summarizer_unavailable");
        return;
      }
      invalidate();
    },
  });

  const manageMutation = useMutation({
    mutationFn: () => manageRpc({ scope_key: scopeKey, action: "auto", max_items: 20 }),
    onSuccess: (result) => {
      if (!result.ok && result.error === "db_error") {
        setDbErrorOpen(true);
        return;
      }
      invalidate();
    },
  });

  const styles = useMemo(
    () => ({
      root: { flex: 1, padding: layout.compact ? 12 : 20, gap: layout.compact ? 8 : 12, backgroundColor: theme.colors.surface0 },
      header: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "600" as const },
      manage: { padding: 10, borderRadius: 8, backgroundColor: theme.colors.accent },
      manageText: { color: theme.colors.accentForeground },
      row: { padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface1 ?? theme.colors.surface0, gap: 6, marginBottom: 8 },
      pill: { color: theme.colors.foreground, fontSize: 12 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      actions: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      action: { padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2 ?? theme.colors.accent },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      notice: { color: theme.colors.foregroundMuted, fontSize: 12 },
      modalBackdrop: { flex: 1, justifyContent: "center" as const, alignItems: "center" as const, backgroundColor: "rgba(0,0,0,0.4)" },
      modalCard: { padding: 20, borderRadius: 12, backgroundColor: theme.colors.surface0, gap: 12, width: "80%" as const },
    }),
    [theme, layout.compact],
  );

  const rows = listQuery.data ?? [];

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Session navigation</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Manage context"
          style={styles.manage}
          onPress={() => manageMutation.mutate()}
        >
          <Text style={styles.manageText}>Manage</Text>
        </Pressable>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Select scope"
        style={styles.action}
        onPress={() => setScopeOpen(true)}
      >
        <Text style={styles.actionText}>Scope: {scopeKey || "(none)"}</Text>
      </Pressable>
      <Modal visible={scopeOpen} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.title}>Select scope</Text>
            <FlatList
              data={scopesQuery.data ?? []}
              keyExtractor={(s) => s.scope_key}
              renderItem={({ item: s }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Use scope ${s.scope_key}`}
                  style={styles.action}
                  onPress={() => { setScopeKey(s.scope_key); setScopeOpen(false); }}
                >
                  <Text style={styles.actionText}>{s.scope_key} ({s.items})</Text>
                </Pressable>
              )}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close scope picker"
              style={styles.manage}
              onPress={() => setScopeOpen(false)}
            >
              <Text style={styles.manageText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <FlatList
        data={rows}
        keyExtractor={(item, index) => item.item_id ?? `${item.tool_call_id}-${index}`}
        renderItem={({ item }) => {
          const isHidden = item.status === "hidden";
          const isUnhidden = item.status === "unhidden";
          return (
            <View style={styles.row}>
              <Text style={styles.pill}>{item.status}</Text>
              <Text style={styles.meta}>{item.tool_call_id}</Text>
              <Text style={styles.meta}>실측 배분 {item.tokens_display}</Text>
              {item.cost_usd != null ? <Text style={styles.meta}>cost {item.cost_usd}</Text> : null}
              <Text style={styles.meta}>v{item.version}</Text>
              <View style={styles.actions}>
                {!isHidden ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Hide row"
                    style={styles.action}
                    onPress={() => hideMutation.mutate(item)}
                  >
                    <Text style={styles.actionText}>Hide</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Summarize row"
                  style={styles.action}
                  onPress={() => summarizeMutation.mutate(item)}
                >
                  <Text style={styles.actionText}>Summarize</Text>
                </Pressable>
                {isHidden && item.item_id ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Unhide row"
                    style={styles.action}
                    onPress={() => unhideMutation.mutate(item)}
                  >
                    <Text style={styles.actionText}>Unhide</Text>
                  </Pressable>
                ) : null}
                {!isHidden && !isUnhidden ? null : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Re-hide row"
                    style={styles.action}
                    onPress={() => hideMutation.mutate(item)}
                  >
                    <Text style={styles.actionText}>Re-hide</Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        }}
      />
      <Modal visible={dbErrorOpen} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.title}>Database error</Text>
            <Text style={styles.meta}>Choose how to proceed.</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Abort request"
              style={styles.manage}
              onPress={async () => {
                await dbChoice({ scope_key: scopeKey, choice: "abort_request" });
                setNotice("db_error: aborted");
                setDbErrorOpen(false);
              }}
            >
              <Text style={styles.manageText}>Abort request</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send original"
              style={styles.action}
              onPress={async () => {
                await dbChoice({ scope_key: scopeKey, choice: "send_original" });
                setNotice("db_error: showing originals once (explicit choice)");
                setDbErrorOpen(false);
                invalidate();
              }}
            >
              <Text style={styles.actionText}>Send original</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}
