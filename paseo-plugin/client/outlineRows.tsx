import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { memo } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import type { Row } from "../shared/sessionNav";
import { actionAllowed, type Capabilities } from "./capabilities";
import {
  groupBadgeText,
  groupEyeAction,
  groupMetric,
  groupRestoreIconKind,
  groupSubtitleText,
  hiddenRowSnippet,
  isSummarizedRow,
  messageSummarySnippet,
  rowMetric,
  type OutlineRow,
} from "./outlineGrouping";

// AI FDE stroke icons (24x24 viewBox, 1.8px stroke, diagonal slash when active/hidden)
export const EYE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';

export const EYE_SLASHED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';

// Vertical compression arrows squeezing a summary bar + 4-point AI star (✦)
export const SUMMARIZE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 2.5v5.2"/><path d="m5.7 5.2 2.8 2.8 2.8-2.8"/><path d="M3 12h11.5"/><path d="M8.5 21.5v-5.2"/><path d="m5.7 18.8 2.8-2.8 2.8 2.8"/><path d="M18.5 2.5 19.6 5.4 22.5 6.5 19.6 7.6 18.5 10.5 17.4 7.6 14.5 6.5 17.4 5.4Z"/></svg>';

export const SUMMARIZE_SLASHED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 2.5v5.2"/><path d="m5.7 5.2 2.8 2.8 2.8-2.8"/><path d="M3 12h11.5"/><path d="M8.5 21.5v-5.2"/><path d="m5.7 18.8 2.8-2.8 2.8 2.8"/><path d="M18.5 2.5 19.6 5.4 22.5 6.5 19.6 7.6 18.5 10.5 17.4 7.6 14.5 6.5 17.4 5.4Z"/><path d="m2 2 20 20"/></svg>';



export function ActionSvgIcon({
  kind,
  slashed,
  size,
  color,
}: {
  kind: "hide" | "summarize";
  slashed: boolean;
  size: number;
  color: string;
}) {
  const svg =
    kind === "hide"
      ? slashed
        ? EYE_SLASHED_SVG
        : EYE_SVG
      : slashed
        ? SUMMARIZE_SLASHED_SVG
        : SUMMARIZE_SVG;

  if (typeof Icon === "function") {
    return <Icon icon={{ svg }} size={size} color={color} />;
  }

  // Fallback geometric rendering for test environments where host UI Icon is mocked/empty
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: size - 2, color, lineHeight: size }}>
        {kind === "hide" ? "◉" : "▤"}
      </Text>
      {slashed ? (
        <View
          style={{
            position: "absolute",
            width: size + 2,
            height: 1.8,
            backgroundColor: color,
            transform: [{ rotate: "45deg" }],
          }}
        />
      ) : null}
    </View>
  );
}

export type MemoGroupBlockProps = {
  group: Extract<OutlineRow, { type: "group" }>;
  isSelected: boolean;
  isExpanded: boolean;
  isPending: boolean;
  resolvedScopeKey: string | null;
  capabilities: Capabilities | undefined;
  compact: boolean;
  hasDocument: boolean;
  theme: PluginAgentPanelProps["theme"];
  styles: any;
  onPressRow: (row: Row) => void;
  onToggleGroup: (groupId: string, currentlyExpanded: boolean) => void;
  onGroupBatch: (group: Extract<OutlineRow, { type: "group" }>, action: "hide" | "summarize" | "unhide") => void;
};

export const MemoGroupBlock = memo(function MemoGroupBlock({
  group,
  isSelected,
  isExpanded,
  isPending,
  resolvedScopeKey,
  capabilities,
  compact,
  hasDocument,
  theme,
  styles,
  onPressRow,
  onToggleGroup,
  onGroupBatch,
}: MemoGroupBlockProps) {
  const eyeAction = groupEyeAction(group);
  const noRemainingManageableVisible = group.allHidden || group.allManageableHidden;
  const restoreIconKind = groupRestoreIconKind(group);
  const badgeText = groupBadgeText(group);
  const subtitleText = groupSubtitleText(group);
  const iconSize = compact ? 13 : 14;

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Tool group: ${group.title}`}
        style={[
          styles.rowItem,
          styles.groupRowItem,
          isSelected ? styles.rowItemSelected : null,
          group.allHidden ? styles.rowItemHidden : null,
        ]}
        onPress={() => {
          if (isExpanded) {
            onToggleGroup(group.groupId, true);
            return;
          }
          onToggleGroup(group.groupId, false);
          if (hasDocument && group.children.length > 0) {
            onPressRow(group.children[0]);
          }
        }}
      >
        <View style={styles.rowMainLine}>
          <View style={styles.rowLeftWrap}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isExpanded ? "Collapse group" : "Expand group"}
              style={styles.expandToggleBtn}
              hitSlop={8}
              onPress={(e) => {
                e.stopPropagation();
                onToggleGroup(group.groupId, isExpanded);
              }}
            >
              <Text style={styles.expandToggleText}>{isExpanded ? "▾" : "▸"}</Text>
            </Pressable>

            <Text style={[styles.itemIcon, group.allHidden ? { color: theme.colors.foregroundMuted } : null]}>
              {group.allHidden ? "⊘" : "⚡"}
            </Text>

            <Text
              style={[
                styles.toolNameText,
                group.allHidden ? { textDecorationLine: "line-through", color: theme.colors.foregroundMuted } : null,
              ]}
              numberOfLines={1}
            >
              {group.title}
            </Text>

            {badgeText ? (
              <View style={styles.mixedBadge}>
                <Text style={styles.mixedBadgeText}>
                  {badgeText}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.rowRightWrap}>
            {resolvedScopeKey && group.children.some((row) => actionAllowed(row, capabilities, row.status === "hidden" ? "unhide" : "hide") || actionAllowed(row, capabilities, "summarize")) ? (
              <View style={[styles.actionsContainer, isPending ? { opacity: 0.5 } : null]}>
                {noRemainingManageableVisible ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Unhide all in ${group.groupId}`}
                    style={styles.inlineIconBtnSlashed}
                    disabled={isPending}
                    onPress={(e) => {
                      e.stopPropagation();
                      onGroupBatch(group, "unhide");
                    }}
                  >
                    <ActionSvgIcon
                      kind={restoreIconKind}
                      slashed={true}
                      size={iconSize}
                      color={theme.colors.foregroundMuted}
                    />
                  </Pressable>
                ) : (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${eyeAction === "unhide" ? "Unhide hidden" : "Hide all"} in ${group.groupId}`}
                      style={eyeAction === "unhide" ? styles.inlineIconBtnSlashed : styles.inlineIconBtn}
                      disabled={isPending || (eyeAction !== "unhide" && !capabilities?.hide)}
                      onPress={(e) => {
                        e.stopPropagation();
                        onGroupBatch(group, eyeAction);
                      }}
                    >
                      <ActionSvgIcon
                        kind={eyeAction === "unhide" ? restoreIconKind : "hide"}
                        slashed={eyeAction === "unhide"}
                        size={iconSize}
                        color={theme.colors.foregroundMuted}
                      />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Summarize all in ${group.groupId}`}
                      style={styles.inlineIconBtn}
                      disabled={isPending || !capabilities?.summarize}
                      onPress={(e) => {
                        e.stopPropagation();
                        onGroupBatch(group, "summarize");
                      }}
                    >
                      <ActionSvgIcon
                        kind="summarize"
                        slashed={false}
                        size={iconSize}
                        color={theme.colors.foregroundMuted}
                      />
                    </Pressable>
                  </>
                )}
              </View>
            ) : null}

            <Text style={[styles.rightMetricsText, group.allHidden ? styles.rightMetricsHidden : null]}>
              {groupMetric(group)}
            </Text>
          </View>
        </View>

        <View style={styles.treeLineContainer}>
          <Text style={noRemainingManageableVisible ? styles.summaryHiddenSnippet : styles.summarySnippet} numberOfLines={1}>
            {subtitleText}
          </Text>
        </View>
      </Pressable>
    </View>
  );
});

export type MemoRowProps = {
  item: OutlineRow;
  isSelected: boolean;
  isExpanded: boolean;
  isPending: boolean;
  resolvedScopeKey: string | null;
  capabilities: Capabilities | undefined;
  lastActionMode: "hide" | "summarize" | undefined;
  compact: boolean;
  hasDocument: boolean;
  theme: PluginAgentPanelProps["theme"];
  styles: any;
  onPressRow: (row: Row) => void;
  onToggleGroup: (groupId: string, currentlyExpanded: boolean) => void;
  onHideRow: (row: Row, mode: "hide" | "summarize") => void;
  onUnhideRow: (row: Row) => void;
  onGroupBatch: (group: Extract<OutlineRow, { type: "group" }>, action: "hide" | "summarize" | "unhide") => void;
};

function formatShortCallId(callId: string): string {
  return callId.length > 12 ? `${callId.slice(0, 4)}…${callId.slice(-4)}` : callId;
}

export const MemoOutlineRowItem = memo(function MemoOutlineRowItem({
  item,
  isSelected,
  isExpanded,
  isPending,
  resolvedScopeKey,
  capabilities,
  lastActionMode,
  compact,
  hasDocument,
  theme,
  styles,
  onPressRow,
  onToggleGroup,
  onHideRow,
  onUnhideRow,
  onGroupBatch,
}: MemoRowProps) {
  const renderMessageHideToggle = (row: Row) => {
    if (!resolvedScopeKey || !row.item_id?.startsWith("msg:")) return null;
    const hidden = row.status === "hidden";
    const iconSize = compact ? 13 : 14;
    return (
      <View style={styles.actionsContainer}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hidden ? "Unhide message" : "Hide message"}
          disabled={!actionAllowed(row, capabilities, hidden ? "unhide" : "hide")}
          style={hidden ? styles.inlineIconBtnSlashed : styles.inlineIconBtn}
          onPress={(e) => {
            e.stopPropagation();
            if (hidden) onUnhideRow(row);
            else onHideRow(row, "hide");
          }}
        >
          <ActionSvgIcon kind="hide" slashed={hidden} size={iconSize} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
    );
  };

  const renderMessageSnippet = (row: Row, empty: string) => {
    const normalized = messageSummarySnippet(row.summary_line ?? row.message_text);
    return row.status === "hidden" ? (
      <Text style={styles.summaryHiddenSnippet} numberOfLines={1}>
        {hiddenRowSnippet(row, false, normalized.split("\n")[0] || "tap icon to restore")}
      </Text>
    ) : (
      <Text style={styles.summarySnippet} numberOfLines={2}>
        {normalized || empty}
      </Text>
    );
  };

  const renderToolActionButtons = (row: Row, isHidden: boolean, summarized: boolean, iconSize: number) => {
    if (!resolvedScopeKey || row.manageable === false) return null;
    return (
      <View style={styles.actionsContainer}>
        {isHidden ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Unhide ${row.tool_call_id}`}
            style={styles.inlineIconBtnSlashed}
            onPress={(e) => {
              e.stopPropagation();
              onUnhideRow(row);
            }}
          >
            <ActionSvgIcon
              kind={summarized ? "summarize" : "hide"}
              slashed={true}
              size={iconSize}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Hide ${row.tool_call_id}`}
              disabled={!actionAllowed(row, capabilities, "hide")}
              style={styles.inlineIconBtn}
              onPress={(e) => {
                e.stopPropagation();
                onHideRow(row, "hide");
              }}
            >
              <ActionSvgIcon
                kind="hide"
                slashed={false}
                size={iconSize}
                color={theme.colors.foregroundMuted}
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Summarize ${row.tool_call_id}`}
              disabled={!actionAllowed(row, capabilities, "summarize")}
              style={styles.inlineIconBtn}
              onPress={(e) => {
                e.stopPropagation();
                onHideRow(row, "summarize");
              }}
            >
              <ActionSvgIcon
                kind="summarize"
                slashed={false}
                size={iconSize}
                color={theme.colors.foregroundMuted}
              />
            </Pressable>
          </>
        )}
      </View>
    );
  };

  if (item.type === "group") {
    return (
      <MemoGroupBlock
        group={item}
        isSelected={isSelected}
        isExpanded={isExpanded}
        isPending={isPending}
        resolvedScopeKey={resolvedScopeKey}
        capabilities={capabilities}
        compact={compact}
        hasDocument={hasDocument}
        theme={theme}
        styles={styles}
        onPressRow={onPressRow}
        onToggleGroup={onToggleGroup}
        onGroupBatch={onGroupBatch}
      />
    );
  }

  const isChild = item.type === "child";
  const row = item.row;
  const isHidden = row.status === "hidden";

  if (!isChild) {
    const kind =
      row.kind ?? (row.tool_name === "user" ? "user" : row.tool_name === "assistant" ? "assistant" : "tool");

    if (kind === "user") {
      return (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="User prompt"
            style={[styles.rowItem, isSelected ? styles.rowItemSelected : null]}
            onPress={() => onPressRow(row)}
          >
            <View style={styles.rowMainLine}>
              <View style={styles.rowLeftWrap}>
                <Text style={{ fontSize: 13, lineHeight: 15, color: theme.colors.accent, flexShrink: 0 }}>◈</Text>
                <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.foreground, flexShrink: 0 }}>
                  User
                </Text>
              </View>
              <View style={styles.rowRightWrap}>
                {renderMessageHideToggle(row)}
                <Text style={[styles.rightMetricsText, isHidden ? styles.rightMetricsHidden : null]}>{rowMetric(row)}</Text>
              </View>
            </View>
            <View style={styles.treeLineContainer}>
              {renderMessageSnippet(row, "(empty prompt)")}
            </View>
          </Pressable>
        </View>
      );
    }

    if (kind === "assistant" || kind === "agent") {
      const agentLabel =
        kind === "agent" && row.tool_name && row.tool_name !== "assistant"
          ? `Agent · ${row.tool_name}`
          : "Agent";
      return (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Agent response"
            style={[styles.rowItem, isSelected ? styles.rowItemSelected : null]}
            onPress={() => onPressRow(row)}
          >
            <View style={styles.rowMainLine}>
              <View style={styles.rowLeftWrap}>
                <Text
                  style={{
                    fontSize: 12,
                    lineHeight: 15,
                    color: /^#[c-fC-F]/.test(theme.colors.surface0) ? "#2563eb" : "#3b82f6",
                    flexShrink: 0,
                  }}
                >
                  ✦
                </Text>
                <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.foreground, flexShrink: 0 }}>
                  {agentLabel}
                </Text>
              </View>
              <View style={styles.rowRightWrap}>
                {renderMessageHideToggle(row)}
                <Text style={[styles.rightMetricsText, isHidden ? styles.rightMetricsHidden : null]}>{rowMetric(row)}</Text>
              </View>
            </View>
            <View style={styles.treeLineContainer}>
              {renderMessageSnippet(row, "(empty response)")}
            </View>
          </Pressable>
        </View>
      );
    }
  }

  const shortCallId = formatShortCallId(row.tool_call_id);
  const metricText = rowMetric(row);
  const firstSummaryLine = (row.summary_line || "").split("\n")[0] || "";
  const summarized = isSummarizedRow(row, lastActionMode);
  const iconSize = isChild ? (compact ? 12 : 13) : (compact ? 13 : 14);
  const restoreFallback = isChild ? "tap icon to restore" : "tap slashed icon to restore";

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${isChild ? "Select tool" : "Select row"} ${row.tool_call_id}`}
        style={[
          styles.rowItem,
          isChild ? styles.childRowItem : null,
          isSelected ? styles.rowItemSelected : null,
          isHidden ? styles.rowItemHidden : null,
        ]}
        onPress={() => onPressRow(row)}
      >
        <View style={styles.rowMainLine}>
          <View style={styles.rowLeftWrap}>
            <Text
              style={[
                styles.itemIcon,
                isHidden ? { color: theme.colors.foregroundMuted } : null,
                isChild ? { fontSize: 9 } : null,
              ]}
            >
              {isHidden ? "⊘" : isChild ? "↳" : "◇"}
            </Text>
            <Text
              style={[
                styles.toolNameText,
                isChild ? { fontSize: compact ? 10 : 11 } : null,
                isHidden ? { textDecorationLine: "line-through", color: theme.colors.foregroundMuted } : null,
              ]}
              numberOfLines={1}
            >
              {row.tool_name ?? "tool"}
            </Text>
            {shortCallId ? (
              <Text style={styles.callIdText} numberOfLines={1}>
                {shortCallId}
              </Text>
            ) : null}
          </View>

          <View style={styles.rowRightWrap}>
            {renderToolActionButtons(row, isHidden, summarized, iconSize)}
            <Text style={[styles.rightMetricsText, isHidden ? styles.rightMetricsHidden : null]}>
              {metricText}
            </Text>
          </View>
        </View>

        <View style={[styles.treeLineContainer, isChild ? { marginLeft: compact ? 8 : 12 } : null]}>
          {isHidden ? (
            <Text style={styles.summaryHiddenSnippet} numberOfLines={1}>
              {hiddenRowSnippet(row, summarized, firstSummaryLine || restoreFallback)}
            </Text>
          ) : (
            <Text style={styles.summarySnippet} numberOfLines={1}>
              {firstSummaryLine || "(no summary)"}
            </Text>
          )}
        </View>
      </Pressable>
    </View>
  );
});

export type OutlineEmptyStateStyles = {
  screen: StyleProp<ViewStyle>;
  header: StyleProp<ViewStyle>;
  headerLeft: StyleProp<ViewStyle>;
  headerTitle: StyleProp<TextStyle>;
  headerAgent: StyleProp<TextStyle>;
  headerRight: StyleProp<ViewStyle>;
  iconBtn: StyleProp<ViewStyle>;
  iconBtnText: StyleProp<TextStyle>;
  list: StyleProp<ViewStyle>;
  emptyContainer: StyleProp<ViewStyle>;
  emptyText: StyleProp<TextStyle>;
  errorText: StyleProp<TextStyle>;
};

export type OutlineEmptyStateTheme = {
  colors: {
    foregroundMuted: string;
  };
};

/**
 * Empty/error outline header. Always offers Refresh (even with zero rows or
 * a failed list fetch) and surfaces the list error instead of a bare empty
 * state.
 */
export function OutlineEmptyState({
  theme,
  styles,
  agentLabel,
  error,
  isRefreshing,
  onRefresh,
  settingsButton,
}: {
  theme: OutlineEmptyStateTheme;
  styles: OutlineEmptyStateStyles;
  agentLabel: string;
  error: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  settingsButton: ReactNode;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Outline</Text>
          <Text style={styles.headerAgent} numberOfLines={1}>
            · {agentLabel}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh outline"
            accessibilityState={{ disabled: isRefreshing }}
            style={styles.iconBtn}
            disabled={isRefreshing}
            onPress={onRefresh}
          >
            <Text style={styles.iconBtnText}>{isRefreshing ? "…" : "↻"}</Text>
          </Pressable>
          {settingsButton}
        </View>
      </View>
      <View style={[styles.list, styles.emptyContainer]}>
        <Text style={styles.emptyText}>No active session</Text>
        <Text
          style={{ fontSize: 11, color: theme.colors.foregroundMuted, textAlign: "center", lineHeight: 16 }}
        >
          This agent has not started a session or has no recorded activity yet.
        </Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    </View>
  );
}
