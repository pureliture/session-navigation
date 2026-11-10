import { length, type Json } from './model.ts';
import { exitClaim, selectableText, splitLines, verifiedFacts } from './policy.ts';
import { pythonInteger, pythonTrim, pythonize } from './python-regex.ts';
import { casefold } from './casefold.ts';

const injection=[/\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i,/\b(?:reveal|print|expose)\s+(?:the\s+)?(?:system|developer|compacted)\s+(?:prompt|message)\b/i,/\b(?:execute|run)\s+(?:this|the)\s+command\b/i,/\b(?:api key|password|credential|secret)\b/i,/이전 지시를 무시|시스템 프롬프트|개발자 지시|비밀을 공개|명령을 실행/];
const generic=[/\bthe\s+summary\s+(?:captures|must|should|includes?|is)\b/i,/\b(?:preserving|preserve|include|included)\s+(?:the\s+)?(?:specified\s+)?source\s+tokens\b/i,/\bthe\s+output\s+requires\b/i,/^\s*concrete\s+findings\s+from\s+result\.source\s*[.!]?\s*$/i,/구체적인\s*주요\s*findings[은는]?\s*명시되지\s*않음/,/\b(?:execution\s+)?details?\s+(?:are|is)\s+not\s+provided\b/i,/\bresult\s+(?:includes?|contains?)\s+(?:only\s+)?observations\b/i,/\brecorded\s+output\s+(?:from\s+the\s+result\s+source\s+)?(?:was|is)\s+provided\s+as\s+detailed\b/i,/(?:결과|실행)(?:의)?\s*(?:구체적인\s*)?(?:내용|정보|상세)(?:이|가)?\s*제공되지\s*(?:않음|않았|않습니다)/];
const identifier=/\b(?:[0-9a-f]{8}-[0-9a-f-]{27,}|(?:id|uuid|sha256)\s*[:=]\s*[\p{L}\p{N}_.-]+)/giu;
const number=/(?<![0-9A-Za-z_])[-+]?\d+(?:[.,]\d+)*(?:%|ms|s)?(?![0-9A-Za-z_])/g;
const pathToken=/(?<![A-Za-z0-9_./\\:~-])(?:(?:[A-Za-z]:|~|\.\.?)[/\\]+|[/\\]+)?[A-Za-z0-9_.-]+(?:[/\\]+[A-Za-z0-9_.-]+)*/g;
const escape=(text:string):string=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function paths(text:string):Set<string> {
  const claims=new Set<string>();for(const match of text.matchAll(pathToken)){const token=match[0].replace(/\.$/,'');if(/^(?:[/\\]|\.{1,2}[/\\]|~[/\\]|[A-Za-z]:[/\\])/.test(token) || (token.match(/[/\\]/g)??[]).length>=2 || /\.[A-Za-z][A-Za-z0-9_-]*$/.test(token))claims.add(token);}return claims;
}
function covers(original:string,text:string):boolean {
  const subjects=new Set([...original.matchAll(pythonize(/\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\s+(?:catalog|component|package)\b/g))].map(m=>m[1]));
  if(subjects.size===1 && !new RegExp(`(?<![\\p{L}\\p{N}_-])${escape([...subjects][0])}(?![\\p{L}\\p{N}_-])`,'iu').test(text))return false;
  const checks=[...original.matchAll(pythonize(/\b(\d+)\s+(?:[A-Za-z]+\s+)?checks?\s+(passed|failed)\b/gi))];
  if(checks.length===1){const [,count,state]=checks[0];if(!pythonize(new RegExp(`\\b${count}\\b`)).test(text) || !pythonize(new RegExp(`\\b${state}\\b`,'i')).test(text))return false;if(verifiedFacts(original).exit_code!==null && ![...text.matchAll(exitClaim)].length)return false;}
  const lines=splitLines(original),warnings=lines.filter(line=>pythonize(/^\s*warning:/i).test(line));
  for(const line of warnings){const m=pythonize(/\b([A-Za-z]+)\s+(?:are|is|were|was)\s+(omitted|missing|unavailable|absent)\b/i).exec(line);if(m){if(![m[1],m[2]].every(word=>pythonize(new RegExp(`\\b${escape(word)}\\b`,'i')).test(text)))return false;if(pythonize(new RegExp(`\\boptional\\s+${escape(m[1])}\\b`,'i')).test(line) && !pythonize(new RegExp(`\\boptional\\s+${escape(m[1])}\\b`,'i')).test(text))return false;}}
  if(lines.some(line=>!warnings.includes(line) && pythonize(/\bordinary\s+(?:[A-Za-z-]+\s+){0,2}annotations?\b/i).test(line)) && !warnings.some(line=>pythonize(/\bannotations?\b/i).test(line)) && pythonize(/\bwarnings?\s+(?:about|of|regarding)\b[^.;!?]*\bannotations?\b|\bannotations?\s+(?:are|(?:noted|categorized|classified)\s+as|as)\s+warnings?\b/i).test(text))return false;
  return true;
}
function valueText(value:Json):string {
  if(Array.isArray(value))return value.map(valueText).join('\n');if(value && typeof value==='object')return Object.values(value).map(valueText).join('\n');return value===null ? 'None' : typeof value==='boolean' ? value ? 'True':'False' : String(value);
}
export function validateSummary(original:string,summary:unknown,required:string[],_invocation?:Json):{summary:string}|undefined {
  if(!summary || Array.isArray(summary) || typeof summary!=='object' || Object.keys(summary).length!==1 || !('summary' in summary))return;
  const text=summary.summary;if(typeof text!=='string' || !pythonTrim(text) || length(text)>1600)return;
  if(required.some(line=>!splitLines(selectableText(original)).includes(line)) || !covers(original,text))return;
  let factual=original;try{const decoded=JSON.parse(original);if(decoded && !Array.isArray(decoded) && typeof decoded==='object')factual+=`\n${valueText(decoded)}`;}catch{}
  if(!covers(factual,text) || injection.some(p=>pythonize(p).test(text)) || generic.some(p=>pythonize(p).test(text)) && !casefold(factual).includes(casefold(text)))return;
  const sourcePaths=paths(factual);if([...paths(text)].some(path=>!sourcePaths.has(path)))return;
  for(const pattern of [identifier,number].map(pythonize)){const facts=new Set([...factual.matchAll(pattern)].map(m=>pythonTrim(m[0])));if([...text.matchAll(pattern)].some(m=>!facts.has(pythonTrim(m[0]))))return;}
  const code=verifiedFacts(original).exit_code;if([...text.matchAll(exitClaim)].some(m=>code===null || pythonInteger(m[1])!==code))return;
  return {summary:pythonTrim(text)};
}
