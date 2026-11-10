import type { RpcInput } from "@getpaseo/plugin";
import { ServiceClient } from "./client";
import {
  hideBatchRpc,
  unhideBatchRpc,
  dbChoiceRpc,
  forkScopeRpc,
  hideItemRpc,
  listItemsRpc,
  manageItemsRpc,
  summarizeItemRpc,
  unhideItemRpc,
} from "../shared/sessionNav";

let client: ServiceClient | undefined;
function request(method: string, input: object = {}) {
  return (client ??= new ServiceClient()).request(method, input);
}
export function closeService(): void {
  client?.close();
  client = undefined;
}
export async function listScopes() {
  const reply = await request("scopes");
  return { scopes: [], ...reply };
}
export async function listItems(input: RpcInput<typeof listItemsRpc>) {
  const reply = await request("list", input);
  return { items: [], ...reply };
}
export function hideItem(input: RpcInput<typeof hideItemRpc>) {
  return request("hide", input);
}
export function unhideItem(input: RpcInput<typeof unhideItemRpc>) {
  return request("unhide", input);
}
export function hideBatch(input: RpcInput<typeof hideBatchRpc>) {
  return request("hideBatch", input).then((reply) => ({
    applied: 0,
    failed: 0,
    items: [],
    ...reply,
  }));
}
export function unhideBatch(input: RpcInput<typeof unhideBatchRpc>) {
  return request("unhideBatch", input).then((reply) => ({
    applied: 0,
    failed: 0,
    items: [],
    ...reply,
  }));
}
export function summarizeItem(input: RpcInput<typeof summarizeItemRpc>) {
  return request("hide", { ...input, mode: "summarize" });
}
export function manageItems(input: RpcInput<typeof manageItemsRpc>) {
  return request("manage", input).then((reply) => ({
    applied: 0,
    failed: 0,
    items: [],
    ...reply,
  }));
}
export function forkScope(input: RpcInput<typeof forkScopeRpc>) {
  return request("fork", {
    scope_key: input.src_scope_key,
    dst_scope_key: input.dst_scope_key,
  });
}
export function dbChoice(input: RpcInput<typeof dbChoiceRpc>) {
  return request("dbChoice", input);
}
