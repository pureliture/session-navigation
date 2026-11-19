import type { PluginServerContext } from "@getpaseo/plugin/server";
import { outlineSettings } from "./shared/outlineSettings";
import {
  getAdapterTogglesRpc,
  hideBatchRpc,
  unhideBatchRpc,
  dbChoiceRpc,
  forkScopeRpc,
  hideItemRpc,
  listItemsRpc,
  listScopesRpc,
  manageItemsRpc,
  setAdapterToggleRpc,
  summarizeItemRpc,
  unhideItemRpc,
} from "./shared/sessionNav";
import {
  getAdapterToggles,
  hideBatch,
  unhideBatch,
  dbChoice,
  forkScope,
  hideItem,
  listItems,
  listScopes,
  manageItems,
  setAdapterToggle,
  summarizeItem,
  unhideItem,
  closeService,
} from "./server/sessionNav";

export default function contribute(server: PluginServerContext) {
  server.registerSettings?.(outlineSettings);
  server.handle(listItemsRpc, listItems);
  server.handle(listScopesRpc, listScopes);
  server.handle(hideItemRpc, hideItem);
  server.handle(unhideItemRpc, unhideItem);
  server.handle(hideBatchRpc, hideBatch);
  server.handle(unhideBatchRpc, unhideBatch);
  server.handle(summarizeItemRpc, summarizeItem);
  server.handle(manageItemsRpc, manageItems);
  server.handle(forkScopeRpc, forkScope);
  server.handle(dbChoiceRpc, dbChoice);
  server.handle(getAdapterTogglesRpc, getAdapterToggles);
  server.handle(setAdapterToggleRpc, setAdapterToggle);
  return () => closeService();
}
