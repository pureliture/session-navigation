import { pythonize } from "./python-regex.ts";
export const numberPattern = pythonize(/(?<![0-9A-Za-z_])[-+]?\d+(?:[.,]\d+)*(?:%|ms|s)?(?![0-9A-Za-z_])/g);
export function normalizeNumber(token: string): string {
  return /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:%|ms|s)?$/.test(token)
    ? token.replaceAll(",", "") : token;
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function equivalentSubstring(source: string, candidate: string): string | undefined {
  const parts: string[] = [];
  let end = 0;
  for (const match of candidate.matchAll(numberPattern)) {
    parts.push(escape(candidate.slice(end, match.index)));
    const token = normalizeNumber(match[0]);
    const numeric = /^([-+]?)(\d+)((?:\.\d+)?(?:%|ms|s)?)$/.exec(token);
    const variants = [match[0], token];
    if (numeric) variants.push(numeric[1] + numeric[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + numeric[3]);
    parts.push(`(?:${[...new Set(variants)].map(escape).join("|")})`);
    end = match.index + match[0].length;
  }
  parts.push(escape(candidate.slice(end)));
  return new RegExp(parts.join(""), "u").exec(source)?.[0];
}
