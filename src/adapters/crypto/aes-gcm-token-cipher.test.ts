import { describe, expect, it } from "vitest";
import type { EncryptedToken } from "../../ports/token-cipher";
import { SECRET_KINDS, secretKeyPurpose, type SecretKind } from "../../ports/settings-store";
import {
  AesGcmTokenCipher,
  createSecretCiphers,
  CURRENT_KEY_VERSION,
  deriveTokenKey,
} from "./aes-gcm-token-cipher";

// Fake secrets and tokens: fixed test vectors, not real credentials.
const SECRET = "test-secret-0123456789abcdefghijklmnop";
const OTHER_SECRET = "rotated-secret-0123456789abcdefghijkl";
const TOKEN = "github_pat_SENTINEL0123456789abcdefWXYZ";

/** Independent HKDF-SHA256 (WebCrypto), so the vector is not the implementation checking itself. */
async function webCryptoKey(secret: string, label: string): Promise<string> {
  const enc = new TextEncoder();
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(label), info: enc.encode(label) },
    ikm,
    256,
  );
  return Buffer.from(bits).toString("hex");
}

const flip = (b64: string, index = 0): string => {
  const bytes = Buffer.from(b64, "base64");
  bytes[index] ^= 0x01;
  return bytes.toString("base64");
};

describe("deriveTokenKey (HKDF-SHA256, salt and info agent-ops:github-token:v1)", () => {
  it("matches an independent HKDF implementation", async () => {
    expect(deriveTokenKey(SECRET, 1).toString("hex")).toBe(
      await webCryptoKey(SECRET, "agent-ops:github-token:v1"),
    );
  });

  it("is 32 bytes, deterministic per secret and version, and differs across both", () => {
    const a = deriveTokenKey(SECRET, 1);
    expect(a).toHaveLength(32);
    expect(deriveTokenKey(SECRET, 1).equals(a)).toBe(true);
    expect(deriveTokenKey(OTHER_SECRET, 1).equals(a)).toBe(false);
    expect(deriveTokenKey(SECRET, 2).equals(a)).toBe(false);
  });
});

describe("AesGcmTokenCipher", () => {
  const cipher = new AesGcmTokenCipher({ secret: SECRET });

  it("round-trips and stores the current key version", () => {
    const enc = cipher.encrypt(TOKEN);
    expect(enc.keyVersion).toBe(CURRENT_KEY_VERSION);
    expect(CURRENT_KEY_VERSION).toBe(1);
    expect(cipher.decrypt(enc)).toEqual({ ok: true, value: TOKEN });
  });

  it("never contains the plaintext in any stored field", () => {
    const enc = cipher.encrypt(TOKEN);
    const stored = JSON.stringify(enc);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(Buffer.from(TOKEN).toString("base64"));
  });

  it("uses a fresh 96-bit IV per encryption", () => {
    const ivs = new Set<string>();
    const cts = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const enc = cipher.encrypt(TOKEN);
      expect(Buffer.from(enc.iv, "base64")).toHaveLength(12);
      expect(Buffer.from(enc.authTag, "base64")).toHaveLength(16);
      ivs.add(enc.iv);
      cts.add(enc.ciphertext);
    }
    expect(ivs.size).toBe(50);
    expect(cts.size).toBe(50);
  });

  it.each<[string, (e: EncryptedToken) => EncryptedToken]>([
    ["a tampered ciphertext", (e) => ({ ...e, ciphertext: flip(e.ciphertext) })],
    ["a tampered auth tag", (e) => ({ ...e, authTag: flip(e.authTag) })],
    ["a tampered IV", (e) => ({ ...e, iv: flip(e.iv) })],
    ["a truncated auth tag", (e) => ({ ...e, authTag: e.authTag.slice(0, 8) })],
    ["a wrong-length IV", (e) => ({ ...e, iv: Buffer.alloc(16).toString("base64") })],
    ["an unknown key version", (e) => ({ ...e, keyVersion: 99 })],
    ["garbage fields", () => ({ ciphertext: "%%%", iv: "", authTag: "", keyVersion: 1 })],
  ])("%s → needs_reset, without throwing", (_name, mutate) => {
    expect(cipher.decrypt(mutate(cipher.encrypt(TOKEN)))).toEqual({
      ok: false,
      error: "needs_reset",
    });
  });

  it("a rotated BETTER_AUTH_SECRET → needs_reset", () => {
    const enc = cipher.encrypt(TOKEN);
    const rotated = new AesGcmTokenCipher({ secret: OTHER_SECRET });
    expect(rotated.decrypt(enc)).toEqual({ ok: false, error: "needs_reset" });
  });

  it("refuses to be built without a secret", () => {
    expect(() => new AesGcmTokenCipher({ secret: "" })).toThrow();
  });
});

/**
 * Fixed vectors: HKDF-SHA256(ikm = SECRET, salt = info = "agent-ops:<purpose>:v1", L = 32),
 * computed once with an independent HMAC-based HKDF (Python stdlib), not with this module.
 */
const VECTORS: Record<string, string> = {
  "github-token": "24e068943dd3ba88c7fa7fb5fc1665352785f7d9775dad7800099f7374ac404b",
  "slack-user-token": "8a58175a6fe8ce874c15d8f252513456416133f80869baf0873b2d110ca1421d",
  "slack-signing-secret": "d8c3009b36c9d344a716e3ae393a92f0fb79d2d56f8dc539e18df89afe5958a8",
  "slack-app-token": "b896bed36b59b2ce152d520d28052f856eaabaa8a28519e351dd507cb1c67b62",
  "jira-api-token": "f0707fa5ddbf889eee8c8542ee4b06902233f22ed32277913e992527f5f13b90",
  "anthropic-api-key": "0d5a74e683021b65f52d8577dea8c48e7093ae83c1e35a53295870714d2160a1",
  "anthropic-auth-token": "1c58f273b5244293d7ce21748bfa98ae29b4ab43a4b94f30b2017aea7bcaa57f",
  "openai-api-key": "aab8ecf42ece8005820cb6792f3a78c2f31549d62e912a1347ac95177c282d73",
};

describe("per-kind HKDF info (FR-SLACKCFG-02, FR-SETTINGS-01)", () => {
  it.each(Object.entries(VECTORS))("agent-ops:%s:v1 matches its fixed vector", (purpose, hex) => {
    expect(deriveTokenKey(SECRET, 1, purpose).toString("hex")).toBe(hex);
  });

  it("the default purpose is the GitHub token, unchanged", () => {
    expect(deriveTokenKey(SECRET, 1).toString("hex")).toBe(VECTORS["github-token"]);
  });

  it("every secret kind maps to its documented purpose, and all keys are distinct", () => {
    const expected: Record<SecretKind, string> = {
      slack_user_token: "slack-user-token",
      slack_signing_secret: "slack-signing-secret",
      slack_app_token: "slack-app-token",
      jira_api_token: "jira-api-token",
      anthropic_api_key: "anthropic-api-key",
      anthropic_auth_token: "anthropic-auth-token",
      openai_api_key: "openai-api-key",
    };
    expect(Object.fromEntries(SECRET_KINDS.map((k) => [k, secretKeyPurpose(k)]))).toEqual(expected);
    const keys = new Set(SECRET_KINDS.map((k) => deriveTokenKey(SECRET, 1, secretKeyPurpose(k))));
    expect(new Set([...keys].map((k) => k.toString("hex"))).size).toBe(SECRET_KINDS.length);
  });

  it("a ciphertext of one kind does not decrypt as another kind (needs_reset)", () => {
    const ciphers = createSecretCiphers({ secret: SECRET });
    const enc = ciphers("slack_user_token").encrypt(TOKEN);
    expect(ciphers("slack_user_token").decrypt(enc)).toEqual({ ok: true, value: TOKEN });
    expect(ciphers("slack_app_token").decrypt(enc)).toEqual({ ok: false, error: "needs_reset" });
    expect(new AesGcmTokenCipher({ secret: SECRET }).decrypt(enc)).toEqual({
      ok: false,
      error: "needs_reset",
    });
  });

  it("createSecretCiphers returns one cipher per kind and refuses an unknown kind", () => {
    const ciphers = createSecretCiphers({ secret: SECRET });
    expect(ciphers("slack_app_token")).toBe(ciphers("slack_app_token"));
    expect(() => ciphers("github" as SecretKind)).toThrow();
  });

  it("refuses a malformed purpose", () => {
    for (const purpose of ["", "Slack", "a:b", "x y"]) {
      expect(() => new AesGcmTokenCipher({ secret: SECRET, purpose })).toThrow();
    }
  });
});
