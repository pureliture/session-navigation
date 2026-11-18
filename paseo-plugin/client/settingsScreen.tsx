import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
  Loading as UiLoading,
  ScrollView as UiScrollView,
  SettingsAction as UiSettingsAction,
  SettingsCard as UiSettingsCard,
  SettingsSection as UiSettingsSection,
  SettingsSwitch as UiSettingsSwitch,
  type SettingsActionProps,
  type SettingsSectionProps,
  type SettingsSwitchProps,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Pressable, ScrollView as RnScrollView, Switch, Text, View } from "react-native";
import { DEFAULT_OUTLINE_SETTINGS } from "../shared/outlineSettings";
import { getAdapterTogglesRpc, setAdapterToggleRpc, type AdapterTogglesResult } from "../shared/sessionNav";
import { resolveOutlineSettingsValues, useOutlineSettings } from "./outlineSettingsHook";

const ScrollView = UiScrollView ?? RnScrollView;

function FallbackSection({ title, children }: SettingsSectionProps) {
  return (
    <View style={{ marginBottom: 20, gap: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: "700" }}>{title}</Text>
      {children}
    </View>
  );
}

function FallbackCard({ children }: { children: ReactNode }) {
  return <View style={{ gap: 10 }}>{children}</View>;
}

function FallbackSwitch({ label, hint, error, value, onValueChange, disabled }: SettingsSwitchProps) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <View style={{ flex: 1 }}>
        <Text>{label}</Text>
        {hint ? <Text>{hint}</Text> : null}
        {error ? <Text>{error}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} disabled={disabled} accessibilityLabel={label} />
    </View>
  );
}

function FallbackAction({ label, hint, error, actionLabel, onPress, disabled }: SettingsActionProps) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <View style={{ flex: 1 }}>
        <Text>{label}</Text>
        {hint ? <Text>{hint}</Text> : null}
        {error ? <Text>{error}</Text> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={actionLabel} disabled={disabled} onPress={onPress}>
        <Text>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

function FallbackLoading() {
  return <Text>Loading settings…</Text>;
}

const SettingsSection = UiSettingsSection ?? FallbackSection;
const SettingsCard = UiSettingsCard ?? FallbackCard;
const SettingsSwitch = UiSettingsSwitch ?? FallbackSwitch;
const SettingsAction = UiSettingsAction ?? FallbackAction;
const Loading = UiLoading ?? FallbackLoading;

const OMP_HINT =
  "Manage tool results and cleanup hints in OMP sessions. Turning off stops new compaction while keeping existing hidden items protected.";
const HERMES_BASE_HINT =
  "Manage tool results and cleanup hints across all Hermes profiles on this host. Turning off stops new compaction while keeping existing hidden items protected.";

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const queryClient = useQueryClient();
  const settings = useOutlineSettings();
  const getTogglesRpc = useRpc(getAdapterTogglesRpc);
  const setToggleRpc = useRpc(setAdapterToggleRpc);

  const togglesQuery = useQuery({
    queryKey: ["session-nav", "adapter-toggles"],
    queryFn: async () => {
      const result = await getTogglesRpc({});
      if (!result.ok) throw new Error(result.error ?? "toggles_failed");
      return result;
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (vars: { adapter: "omp" | "hermes"; enabled: boolean }) => setToggleRpc(vars),
    onSuccess: (data) => {
      if (data?.ok) {
        queryClient.setQueryData<AdapterTogglesResult>(["session-nav", "adapter-toggles"], data);
      } else {
        void queryClient.invalidateQueries({ queryKey: ["session-nav", "adapter-toggles"] });
      }
      void queryClient.invalidateQueries({ queryKey: ["session-nav", "scopes"] });
      void queryClient.invalidateQueries({ queryKey: ["session-nav", "list"] });
    },
  });

  if (settings.status === "loading" && togglesQuery.isPending) {
    return <Loading />;
  }

  const values = resolveOutlineSettingsValues(settings);
  const toggles = togglesQuery.data;
  const omp = toggles?.omp ?? { installed: true, enabled: true };
  const hermes = toggles?.hermes ?? { installed: false, enabled: false, profileCount: 0 };

  const hermesHint = !toggles && togglesQuery.isPending
    ? HERMES_BASE_HINT
    : !hermes.installed
      ? `${HERMES_BASE_HINT} Not installed on this host.`
      : `${HERMES_BASE_HINT} (${hermes.profileCount} ${hermes.profileCount === 1 ? "profile" : "profiles"}${hermes.mixed ? ", mixed state" : ""})`;

  const toggleError =
    togglesQuery.error instanceof Error
      ? togglesQuery.error.message
      : toggleMutation.error instanceof Error
        ? toggleMutation.error.message
        : toggles && !toggles.ok
          ? toggles.error ?? null
          : toggleMutation.data && !toggleMutation.data.ok
            ? toggleMutation.data.error ?? null
            : null;

  const isModified =
    values.followVisibleSession !== DEFAULT_OUTLINE_SETTINGS.followVisibleSession ||
    values.openPreviewOnRowClick !== DEFAULT_OUTLINE_SETTINGS.openPreviewOnRowClick;

  const outlineError =
    settings.status === "error" || settings.status === "invalid"
      ? settings.error
      : settings.saveError;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 16 }}
    >
      <SettingsSection title="Agent Integration">
        <SettingsCard>
          <SettingsSwitch
            label="OMP"
            hint={omp.error ? `${OMP_HINT} (${omp.error})` : OMP_HINT}
            value={omp.enabled}
            disabled={togglesQuery.isPending || !omp.installed || toggleMutation.isPending}
            error={omp.error ?? (toggleMutation.variables?.adapter === "omp" ? toggleError : null)}
            onValueChange={(enabled) => toggleMutation.mutate({ adapter: "omp", enabled })}
          />
          <SettingsSwitch
            label="Hermes"
            hint={hermesHint}
            value={hermes.enabled}
            disabled={togglesQuery.isPending || !hermes.installed || toggleMutation.isPending}
            error={hermes.error ?? (toggleMutation.variables?.adapter === "hermes" ? toggleError : null)}
            onValueChange={(enabled) => toggleMutation.mutate({ adapter: "hermes", enabled })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Outline">
        <SettingsCard>
          <SettingsSwitch
            label="Follow visible session"
            hint="Automatically follow whichever session is active in the workspace."
            value={values.followVisibleSession}
            disabled={settings.status !== "ready" || settings.saving}
            error={outlineError}
            onValueChange={(followVisibleSession) => {
              if (settings.status === "ready") {
                void settings.save({ ...values, followVisibleSession }, settings.revision);
              }
            }}
          />
          <SettingsSwitch
            label="Open preview on row click"
            hint="Also open the bottom raw-content preview drawer when clicking an outline row."
            value={values.openPreviewOnRowClick}
            disabled={settings.status !== "ready" || settings.saving}
            onValueChange={(openPreviewOnRowClick) => {
              if (settings.status === "ready") {
                void settings.save({ ...values, openPreviewOnRowClick }, settings.revision);
              }
            }}
          />
          {isModified || settings.status === "invalid" ? (
            <SettingsAction
              label="Reset to defaults"
              hint="Restore default outline settings."
              actionLabel="Reset to defaults"
              disabled={(settings.status !== "ready" && settings.status !== "invalid") || settings.saving}
              onPress={() => {
                void settings.reset();
              }}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}
