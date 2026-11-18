/** Query keys a manual outline refresh must invalidate. Agent-scoped keys take agentId. */
export function outlineRefreshQueryKeys(agentId?: string | null): Array<readonly unknown[]> {
  return [
    ["session-nav", "list"],
    ["session-nav", "scopes"],
    ["paseo-agent-usage", agentId],
    ["paseo-agent-timeline", agentId],
  ];
}
