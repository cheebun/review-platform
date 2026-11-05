/**
 * Login token hashing: PBKDF2-HMAC-SHA256 over WebCrypto (`crypto.subtle`) only, so the same
 * code runs on Node and Cloudflare Workers. Server-only by use (never imported from client code),
 * and free of Node built-ins either way.
 *
 * Encoding: `pbkdf2-sha256$<iterations>$<b64url salt>$<b64url hash>`, base64url without padding.
 * The iteration count is read back from the encoding, so raising it later keeps old hashes
 * verifiable.
 */

export const LOGIN_TOKEN_HASH_ITERATIONS = 600_000;

const SCHEME = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BYTES = 32;
/** Upper bound accepted on verify, so a corrupt row cannot pin a CPU. */
const MAX_ITERATIONS = 10_000_000;

const ITERATIONS_RE = /^[1-9][0-9]{0,7}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function toB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict decode: base64url alphabet, no padding, exact byte length. Null on anything else. */
function fromB64url(text: string, bytes: number): Uint8Array | null {
  if (!B64URL_RE.test(text) || text.length !== Math.ceil((bytes * 4) / 3)) return null;
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (binary.length !== bytes) return null;
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = binary.charCodeAt(i);
  // Reject non-canonical encodings (unused trailing bits set).
  return toB64url(out) === text ? out : null;
}

async function derive(token: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Constant time in the content for equal lengths; lengths here are fixed by the encoding. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Hashes a login token with a fresh random salt. Validate the token first
 * (`validateLoginTokenInput`); an empty or non-string token is a programming error and rejects.
 */
export async function hashLoginToken(token: string): Promise<string> {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("hashLoginToken: empty token");
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(token, salt, LOGIN_TOKEN_HASH_ITERATIONS);
  return `${SCHEME}$${LOGIN_TOKEN_HASH_ITERATIONS}$${toB64url(salt)}$${toB64url(hash)}`;
}

/** True only when `token` matches `encoded`. Never throws: anything malformed is false. */
export async function verifyLoginToken(token: string, encoded: string): Promise<boolean> {
  try {
    if (typeof token !== "string" || token.length === 0) {
      return false;
    }
    if (typeof encoded !== "string") return false;
    const parts = encoded.split("$");
    if (parts.length !== 4) return false;
    const [scheme, iter, saltText, hashText] = parts as [string, string, string, string];
    if (scheme !== SCHEME || !ITERATIONS_RE.test(iter)) return false;
    const iterations = Number(iter);
    if (iterations > MAX_ITERATIONS) return false;
    const salt = fromB64url(saltText, SALT_BYTES);
    const expected = fromB64url(hashText, HASH_BYTES);
    if (!salt || !expected) return false;
    return timingSafeEqual(await derive(token, salt, iterations), expected);
  } catch {
    return false;
  }
}
