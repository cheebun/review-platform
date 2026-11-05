import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOGIN_TOKEN_HASH_ITERATIONS, hashLoginToken, verifyLoginToken } from "./login-token-hash";

// Fake tokens: test vectors only.
const TOKEN = "test-login-token-0123456789abcdefghijklmnop";
const OTHER = "test-login-token-0123456789abcdefghijklmnoq";

const B64URL = "[A-Za-z0-9_-]+";
const ENCODED = new RegExp(`^pbkdf2-sha256\\$600000\\$(${B64URL})\\$(${B64URL})$`);

/** base64url without padding → bytes, independently of the module under test. */
const decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

describe("hashLoginToken / verifyLoginToken", () => {
  it("uses 600000 PBKDF2 iterations", () => {
    expect(LOGIN_TOKEN_HASH_ITERATIONS).toBe(600_000);
  });

  it("encodes pbkdf2-sha256$<iter>$<16-byte salt>$<32-byte hash>", async () => {
    const encoded = await hashLoginToken(TOKEN);
    const m = ENCODED.exec(encoded);
    expect(m).not.toBeNull();
    expect(decode(m![1]!)).toHaveLength(16);
    expect(decode(m![2]!)).toHaveLength(32);
    expect(encoded).not.toContain(TOKEN);
  });

  it("round-trips", async () => {
    expect(await verifyLoginToken(TOKEN, await hashLoginToken(TOKEN))).toBe(true);
  });

  it("round-trips a very long token (no maximum length)", async () => {
    const long = "x".repeat(10_000);
    const encoded = await hashLoginToken(long);
    expect(await verifyLoginToken(long, encoded)).toBe(true);
    expect(await verifyLoginToken(`${long}y`, encoded)).toBe(false);
  });

  it("rejects a wrong token", async () => {
    const encoded = await hashLoginToken(TOKEN);
    expect(await verifyLoginToken(OTHER, encoded)).toBe(false);
    expect(await verifyLoginToken(`${TOKEN} `, encoded)).toBe(false);
    expect(await verifyLoginToken("", encoded)).toBe(false);
  });

  it("gives distinct encodings for the same token (random salt)", async () => {
    const [a, b] = await Promise.all([hashLoginToken(TOKEN), hashLoginToken(TOKEN)]);
    expect(a).not.toBe(b);
    expect(a.split("$")[2]).not.toBe(b.split("$")[2]);
    expect(await verifyLoginToken(TOKEN, a)).toBe(true);
    expect(await verifyLoginToken(TOKEN, b)).toBe(true);
  });

  it("matches an independent PBKDF2-HMAC-SHA256 derivation", async () => {
    const { pbkdf2Sync } = await import("node:crypto");
    const encoded = await hashLoginToken(TOKEN);
    const [, , salt, hash] = encoded.split("$");
    const expected = pbkdf2Sync(TOKEN, decode(salt!), 600_000, 32, "sha256");
    expect(Buffer.from(decode(hash!)).equals(expected)).toBe(true);
  });

  it("verifies a lower iteration count stored in the encoding", async () => {
    const { pbkdf2Sync } = await import("node:crypto");
    const salt = new Uint8Array(16).fill(7);
    const hash = pbkdf2Sync(TOKEN, salt, 1000, 32, "sha256");
    const encoded = `pbkdf2-sha256$1000$${Buffer.from(salt).toString("base64url")}$${hash.toString("base64url")}`;
    expect(await verifyLoginToken(TOKEN, encoded)).toBe(true);
    expect(await verifyLoginToken(OTHER, encoded)).toBe(false);
  });

  describe("malformed encodings return false, never throw", () => {
    // Well-formed parts (16-byte salt, 32-byte hash) to break one at a time.
    const iter = "600000";
    const salt = Buffer.alloc(16, 1).toString("base64url");
    const hash = Buffer.alloc(32, 2).toString("base64url");
    const good = `pbkdf2-sha256$${iter}$${salt}$${hash}`;
    const cases: Array<[string, unknown]> = [
      ["empty", ""],
      ["not a string", null],
      ["undefined", undefined],
      ["garbage", "not-a-hash"],
      ["wrong scheme", `bcrypt$${iter}$${salt}$${hash}`],
      ["missing part", `pbkdf2-sha256$${iter}$${salt}`],
      ["extra part", `${good}$x`],
      ["zero iterations", `pbkdf2-sha256$0$${salt}$${hash}`],
      ["negative iterations", `pbkdf2-sha256$-1$${salt}$${hash}`],
      ["non-numeric iterations", `pbkdf2-sha256$abc$${salt}$${hash}`],
      ["leading-zero iterations", `pbkdf2-sha256$0600000$${salt}$${hash}`],
      ["absurd iterations", `pbkdf2-sha256$99999999999$${salt}$${hash}`],
      ["empty salt", `pbkdf2-sha256$${iter}$$${hash}`],
      ["short salt", `pbkdf2-sha256$${iter}$${salt.slice(0, 8)}$${hash}`],
      ["bad salt chars", `pbkdf2-sha256$${iter}$${salt.slice(0, -1)}!$${hash}`],
      ["short hash", `pbkdf2-sha256$${iter}$${salt}$${hash.slice(0, 20)}`],
      ["padded hash", `pbkdf2-sha256$${iter}$${salt}$${hash}=`],
      ["standard base64 hash", `pbkdf2-sha256$${iter}$${salt}$${hash.replace(/[-_]/g, "+")}+`],
      ["surrounding whitespace", ` ${good}`],
    ];
    it.each(cases)("%s", async (_name, encoded) => {
      await expect(verifyLoginToken(TOKEN, encoded as string)).resolves.toBe(false);
    });
  });

  it("returns false for a non-string token", async () => {
    const encoded = await hashLoginToken(TOKEN);
    await expect(verifyLoginToken(undefined as unknown as string, encoded)).resolves.toBe(false);
  });

  it("refuses to hash an empty or non-string token", async () => {
    await expect(hashLoginToken("")).rejects.toThrow();
    await expect(hashLoginToken(42 as unknown as string)).rejects.toThrow();
  });

  it("imports no Node built-in (runs on Workers)", () => {
    const source = readFileSync(new URL("./login-token-hash.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:node:)?crypto["']/);
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/\bBuffer\b/);
  });
});
