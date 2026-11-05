const FALLBACK = "/";
const MAX_DECODE_ROUNDS = 3;

function hasControlOrBackslash(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

/** Same-origin check for one string: a single leading `/`, never `//` or `/\`. */
function isSafeStage(text: string): boolean {
  return text.startsWith("/") && !text.startsWith("//") && !hasControlOrBackslash(text);
}

/**
 * Sanitises a post-login `redirect` value. Only same-origin relative paths that start with a
 * single `/` pass. The value is also checked after up to three rounds of percent-decoding, so
 * `/%2Fevil.com` and `/%255Cevil.com` cannot turn into `//evil.com` or `/\evil.com` later.
 * Anything else, including non-strings, falls back to `/`.
 */
export function safeRedirect(value: unknown): string {
  if (typeof value !== "string") return FALLBACK;
  let stage = value;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round++) {
    if (!isSafeStage(stage)) return FALLBACK;
    let next: string;
    try {
      next = decodeURIComponent(stage);
    } catch {
      return FALLBACK;
    }
    if (next === stage) return value;
    stage = next;
  }
  return FALLBACK;
}
