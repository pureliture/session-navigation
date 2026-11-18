import * as PaseoClient from "@getpaseo/plugin/client";
import type { SettingsState } from "@getpaseo/plugin/client";
import {
  DEFAULT_OUTLINE_SETTINGS,
  outlineSettings,
  type OutlineSettingsValues,
} from "../shared/outlineSettings";

export type OutlineSettingsState = SettingsState<typeof outlineSettings.schema>;

let overrideHook: (() => OutlineSettingsState) | null = null;

export function setUseOutlineSettingsOverride(fn: (() => OutlineSettingsState) | null): void {
  overrideHook = fn;
}

const FALLBACK_STATE: OutlineSettingsState = {
  status: "ready",
  revision: "default",
  values: DEFAULT_OUTLINE_SETTINGS,
  saving: false,
  saveError: null,
  save: async () => true,
  reset: async () => true,
  reload: async () => {},
};

export function useOutlineSettings(): OutlineSettingsState {
  if (overrideHook) {
    return overrideHook();
  }
  const hostHook = (
    PaseoClient as { useSettings?: (def: typeof outlineSettings) => OutlineSettingsState }
  ).useSettings;
  if (typeof hostHook === "function") {
    try {
      return hostHook(outlineSettings);
    } catch {
      return FALLBACK_STATE;
    }
  }
  return FALLBACK_STATE;
}

export function resolveOutlineSettingsValues(
  state?: Partial<OutlineSettingsState> | null,
): OutlineSettingsValues {
  if (state?.status === "ready" && state.values) {
    return {
      followVisibleSession:
        typeof state.values.followVisibleSession === "boolean"
          ? state.values.followVisibleSession
          : DEFAULT_OUTLINE_SETTINGS.followVisibleSession,
      openPreviewOnRowClick:
        typeof state.values.openPreviewOnRowClick === "boolean"
          ? state.values.openPreviewOnRowClick
          : DEFAULT_OUTLINE_SETTINGS.openPreviewOnRowClick,
    };
  }
  return DEFAULT_OUTLINE_SETTINGS;
}

export function shouldOpenPreviewDrawerOnRowPress({
  hasDocument,
  openPreviewOnRowClick,
}: {
  hasDocument: boolean;
  openPreviewOnRowClick?: boolean;
}): boolean {
  return !hasDocument || Boolean(openPreviewOnRowClick);
}
