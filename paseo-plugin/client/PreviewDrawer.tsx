import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import type { Row } from "../shared/sessionNav";
import { previewContent } from "./previewContent";

export function PreviewDrawer({ row, open, onToggle, theme }: {
  row: Row | null;
  open: boolean;
  onToggle: () => void;
  theme: PluginAgentPanelProps["theme"];
}) {
  const content = previewContent(row);
  const labelStyle = { fontSize: 10, color: theme.colors.foregroundMuted, minWidth: 0, flexShrink: 1 };
  return (
    <View testID="session-nav-preview" style={{ borderTopWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0, minWidth: 0, flexShrink: 1 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Toggle preview drawer" accessibilityState={{ expanded: open }}
        onPress={onToggle} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 8, minWidth: 0 }}>
        <Text style={{ ...labelStyle, fontSize: 11 }}>Preview</Text>
        <Text numberOfLines={1} style={{ ...labelStyle, flex: 1 }}>{content.subtitle}</Text>
        <Text style={labelStyle}>{open ? "︾" : "︽"}</Text>
      </Pressable>
      {open ? row ? (
        <View style={{ minWidth: 0, flexShrink: 1 }}>
          <ScrollView style={{ maxHeight: 270, minWidth: 0 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 10, gap: 10 }}>
            {content.sections.map((section) => (
              <View key={section.label} style={{ gap: 4, minWidth: 0, flexShrink: 1 }}>
                <Text style={labelStyle}>{section.label}</Text>
                <ScrollView nestedScrollEnabled style={{ maxHeight: 100, minWidth: 0, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 4 }} contentContainerStyle={{ padding: 8 }}>
                  <Text selectable style={{ fontFamily: "monospace", fontSize: 11, lineHeight: 16, color: theme.colors.foreground, minWidth: 0, flexShrink: 1 }}>{section.text}</Text>
                </ScrollView>
              </View>
            ))}
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 24, minWidth: 0 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            <Text selectable numberOfLines={1} style={{ ...labelStyle, fontSize: 9, flexShrink: 0 }}>{content.metadata}</Text>
          </ScrollView>
        </View>
      ) : <Text style={{ ...labelStyle, paddingHorizontal: 12, paddingBottom: 12 }}>Select an item to preview</Text> : null}
    </View>
  );
}
