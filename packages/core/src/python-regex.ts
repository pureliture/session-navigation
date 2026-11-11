const word = "[\\p{L}\\p{N}_]";
const space = "\\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\p{Z}";
export function pythonRegex(pattern: string, flags = ""): RegExp {
  // Emulate Python's Unicode word boundaries, whitespace and IGNORECASE additions.
  let source = "";
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") {
      const escapeCode = pattern[++index];
      if (escapeCode === "b" && !inClass) {
        source += `(?:(?<=${word})(?!${word})|(?<!${word})(?=${word}))`;
      } else if (escapeCode === "w") {
        source += inClass ? "\\p{L}\\p{N}_" : word;
      } else if (escapeCode === "d") {
        source += "\\p{Nd}";
      } else if (escapeCode === "s") {
        source += inClass ? space : `[${space}]`;
      } else if (escapeCode === "S") {
        source += inClass ? "\\S" : `[^${space}]`;
      } else if (escapeCode === "p" || escapeCode === "P") {
        const propertyEnd = pattern.indexOf("}", index);
        source += pattern.slice(index - 1, propertyEnd + 1);
        index = propertyEnd;
      } else {
        source += `\\${escapeCode}`;
      }
    } else if (character === "." && !inClass) {
      source += flags.includes("s") ? "[\\s\\S]" : "[^\\n]";
    } else if (character === "[") {
      inClass = true;
      source += character;
    } else if (character === "]") {
      if (flags.includes("i") && /[aA]-[zZ]/.test(source.slice(source.lastIndexOf("[")))) {
        source += "İıſK";
      }
      inClass = false;
      source += character;
    } else if (!inClass && flags.includes("i") && /[iIsSkK]/.test(character)) {
      source += /[iI]/.test(character) ? "[iİı]" : /[sS]/.test(character) ? "[sſ]" : "[kK]";
    } else {
      source += character;
    }
  }
  return new RegExp(source, [...new Set((flags + "u").split(""))].join(""));
}
export const pythonize = (regex: RegExp): RegExp => pythonRegex(regex.source, regex.flags);
export const pythonTrim = (text: string): string =>
  text.replace(pythonRegex("^\\s+|\\s+$", "g"), "");
const decimalZeros = [
  48, 1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430, 3558, 3664, 3792,
  3872, 4160, 4240, 6112, 6160, 6470, 6608, 6784, 6800, 6992, 7088, 7232, 7248, 42528, 43216, 43264,
  43472, 43504, 43600, 44016, 65296, 66720, 68912, 69734, 69872, 69942, 70096, 70384, 70736, 70864,
  71248, 71360, 71472, 71904, 72016, 72784, 73040, 73120, 73552, 92768, 92864, 93008, 120782,
  120792, 120802, 120812, 120822, 123200, 123632, 124144, 125264, 130032,
];
export function pythonInteger(text: string): number {
  const normalized = [...text]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      const zero = decimalZeros.find(
        (zeroCodePoint) => codePoint >= zeroCodePoint && codePoint < zeroCodePoint + 10,
      );
      return zero === undefined ? character : String(codePoint - zero);
    })
    .join("");
  return Number(normalized);
}
