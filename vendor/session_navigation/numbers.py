"""Exact numeric spelling equivalence without changing identifiers or units."""
import re

NUMBER = re.compile(r"(?<![0-9A-Za-z_])[-+]?\d+(?:[.,]\d+)*(?:%|ms|s)?(?![0-9A-Za-z_])")
GROUPED = re.compile(r"[-+]?[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?(?:%|ms|s)?")


def normalize_number(token: str) -> str:
    return token.replace(",", "") if GROUPED.fullmatch(token) else token


def equivalent_substring(source: str, candidate: str) -> str | None:
    parts, end = [], 0
    for match in NUMBER.finditer(candidate):
        parts.append(re.escape(candidate[end:match.start()]))
        token = normalize_number(match[0])
        numeric = re.fullmatch(r"([-+]?)([0-9]+)((?:\.[0-9]+)?(?:%|ms|s)?)", token)
        variants = [match[0], token]
        if numeric:
            sign, digits, suffix = numeric.groups()
            groups = [digits[max(0, i - 3):i] for i in range(len(digits), 0, -3)]
            variants.append(sign + ",".join(reversed(groups)) + suffix)
        parts.append("(?:" + "|".join(re.escape(value) for value in dict.fromkeys(variants)) + ")")
        end = match.end()
    parts.append(re.escape(candidate[end:]))
    match = re.search("".join(parts), source)
    return match[0] if match else None
