export function previewText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  return text.length <= 8192 ? text : text.slice(0, 8192) + "\n… [truncated]";
}

export function fallbackToolPreview(item: Record<string, unknown>, detail: Record<string, unknown>) {
  const input = item.args ?? item.input ?? detail.args ?? detail.input ??
    (detail.command !== undefined ? { command: detail.command } :
      detail.cmd !== undefined ? { command: detail.cmd } :
        detail.filePath !== undefined ? { path: detail.filePath } : undefined);
  const output = item.result ?? detail.result ?? detail.output ?? detail.content ?? detail.unifiedDiff ?? detail.log;
  return { tool_input: previewText(input), tool_output: previewText(output) };
}
