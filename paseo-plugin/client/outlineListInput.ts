/** Build the full-session outline request; row limits are never sent. */
export function outlineListInput(scopeKey: string, query: string) {
  return { scope_key: scopeKey, query: query || undefined };
}
