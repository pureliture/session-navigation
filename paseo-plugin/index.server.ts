import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  dbChoiceRpc,
  forkScopeRpc,
  hideItemRpc,
  listItemsRpc,
  manageItemsRpc,
  summarizeItemRpc,
  unhideItemRpc,
} from "./shared/sessionNav";
import {
  dbChoice,
  forkScope,
  hideItem,
  listItems,
  manageItems,
  summarizeItem,
  unhideItem,
} from "./server/sessionNav";

export default function contribute(server: PluginServerContext) {
  server.handle(listItemsRpc, listItems);
  server.handle(hideItemRpc, hideItem);
  server.handle(unhideItemRpc, unhideItem);
  server.handle(summarizeItemRpc, summarizeItem);
  server.handle(manageItemsRpc, manageItems);
  server.handle(forkScopeRpc, forkScope);
  server.handle(dbChoiceRpc, dbChoice);
  return () => {};
}
