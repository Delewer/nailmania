export const SQLITE_LIKE_PATTERN_MAX_BYTES = 50;

const encoder = new TextEncoder();
const escapedLikeSymbol = (symbol) => (
  symbol === '\\' || symbol === '%' || symbol === '_' ? `\\${symbol}` : symbol
);

export function clampLikeTerm(value, { escape = false, maxPatternBytes = SQLITE_LIKE_PATTERN_MAX_BYTES } = {}) {
  const input = String(value ?? '').trim();
  const budget = Math.max(0, Number(maxPatternBytes) - 2);
  let used = 0;
  let result = '';
  for (const symbol of input) {
    const patternSymbol = escape ? escapedLikeSymbol(symbol) : symbol;
    const bytes = encoder.encode(patternSymbol).byteLength;
    if (used + bytes > budget) break;
    result += symbol;
    used += bytes;
  }
  return result;
}

export function likeContainsPattern(value, options = {}) {
  const term = clampLikeTerm(value, options);
  if (!term) return '';
  const body = options.escape
    ? [...term].map(escapedLikeSymbol).join('')
    : term;
  return `%${body}%`;
}
