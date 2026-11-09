import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  hideBatchRpc,
  unhideBatchRpc,
  dbChoiceRpc,
  forkScopeRpc,
  hideItemRpc,
  listItemsRpc,
  listScopesRpc,
  manageItemsRpc,
  summarizeItemRpc,
  unhideItemRpc,
} from "./shared/sessionNav";
import {
  hideBatch,
  unhideBatch,
  dbChoice,
  forkScope,
  hideItem,
  listItems,
  listScopes,
  manageItems,
  summarizeItem,
  unhideItem,
} from "./server/sessionNav";

export default function contribute(server: PluginServerContext) {
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
  return () => {};
}
