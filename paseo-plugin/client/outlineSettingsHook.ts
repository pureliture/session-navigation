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

function unsupportedState(reason: string): OutlineSettingsState {
  return {
    status: "error",
    error: reason,
    saving: false,
    saveError: reason,
    save: async () => false,
    reset: async () => false,
    reload: async () => {},
  };
}

// Older hosts predate the settings API, so useSettings may be absent at
// runtime even though the SDK types it. Read it through a named boundary
// type instead of an inline cast.
type HostSettingsClient = {
  useSettings?: (def: typeof outlineSettings) => OutlineSettingsState;
};

export function outlineSettingsFromHostHook(
  readHook: () => ((def: typeof outlineSettings) => OutlineSettingsState) | undefined,
): OutlineSettingsState {
  // An older host without the settings API — or a throwing host hook — must
  // surface an explicit error state instead of a silent no-op "ready" that
  // makes the user believe their settings were saved.
  let hostHook: ((def: typeof outlineSettings) => OutlineSettingsState) | undefined;
  try {
    hostHook = readHook();
  } catch (err) {
    return unsupportedState(
      err instanceof Error && err.message ? err.message : "outline_settings_unavailable",
    );
  }
  if (typeof hostHook !== "function") {
    return unsupportedState("outline_settings_unsupported");
  }
  try {
    return hostHook(outlineSettings);
  } catch (err) {
    return unsupportedState(
      err instanceof Error && err.message ? err.message : "outline_settings_unavailable",
    );
  }
}

export function useOutlineSettings(): OutlineSettingsState {
  if (overrideHook) {
    return overrideHook();
  }
  const hostClient: HostSettingsClient = PaseoClient;
  return outlineSettingsFromHostHook(() => hostClient.useSettings);
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
