/**
 * Cross-source identity for compaction-summary rows (P1-3). The same summary
 * surfaces with different kinds per source (server "user"/"assistant" vs
 * fallback "agent"/compaction), so identity ignores kind and matches on the
 * full text hash: equal summary text dedupes, while distinct long messages
 * sharing a prefix never do. Pure and dependency-free so both the server
 * timeline builder and the client fallback merge can use it consistently
 * without dragging zod/RPC schemas into the worker bundle.
 */
export function summaryDedupeKey(fullText: string): string {
  return `summary\0${fnv1a32(fullText)}`;
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
