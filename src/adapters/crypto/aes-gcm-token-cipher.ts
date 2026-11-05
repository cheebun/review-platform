import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { err, ok, type Result } from "../../domain/shared/result";
import {
  SECRET_KINDS,
  secretKeyPurpose,
  type SecretCiphers,
  type SecretKind,
} from "../../ports/settings-store";
import type { EncryptedToken, TokenCipher } from "../../ports/token-cipher";

/** Bumped (with a new label) only when the derivation changes; old rows keep their version. */
export const CURRENT_KEY_VERSION = 1;

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Key versions this build can derive. A new version gets a new label suffix. */
const KEY_VERSIONS: ReadonlySet<number> = new Set([1]);

/** The GitHub token's purpose; the default, so `github_credential` rows keep decrypting. */
export const GITHUB_TOKEN_PURPOSE = "github-token";

const PURPOSE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `agent-ops:<purpose>:v<version>`, used as both HKDF salt and info (FR-GITHUB-03, FR-SETTINGS-01). */
const label = (purpose: string, keyVersion: number): string =>
  `agent-ops:${purpose}:v${keyVersion}`;

/** HKDF-SHA256 of the auth secret. Pure and deterministic for (secret, version, purpose). */
export function deriveTokenKey(
  secret: string,
  keyVersion: number,
  purpose: string = GITHUB_TOKEN_PURPOSE,
): Buffer {
  const l = label(purpose, keyVersion);
  return Buffer.from(hkdfSync("sha256", secret, l, l, KEY_BYTES));
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decode(value: unknown, bytes?: number): Buffer | null {
  if (typeof value !== "string" || !BASE64_RE.test(value)) return null;
  const buf = Buffer.from(value, "base64");
  if (bytes !== undefined && buf.length !== bytes) return null;
  return buf;
}

/**
 * AES-256-GCM with a random 96-bit IV per write and a 128-bit tag. The key is derived once per
 * version and lives only in this object; plaintext is never logged. `purpose` selects the HKDF
 * info, so a ciphertext of one kind never decrypts as another.
 */
export class AesGcmTokenCipher implements TokenCipher {
  private readonly keys = new Map<number, Buffer>();
  private readonly purpose: string;

  constructor(private readonly options: { secret: string; purpose?: string }) {
    if (!options.secret) throw new Error("AesGcmTokenCipher needs a non-empty secret");
    this.purpose = options.purpose ?? GITHUB_TOKEN_PURPOSE;
    if (!PURPOSE_RE.test(this.purpose)) throw new Error("AesGcmTokenCipher: invalid purpose");
  }

  private key(keyVersion: number): Buffer | null {
    if (!KEY_VERSIONS.has(keyVersion)) return null;
    let key = this.keys.get(keyVersion);
    if (!key) {
      key = deriveTokenKey(this.options.secret, keyVersion, this.purpose);
      this.keys.set(keyVersion, key);
    }
    return key;
  }

  encrypt(plaintext: string): EncryptedToken {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key(CURRENT_KEY_VERSION)!, iv, {
      authTagLength: TAG_BYTES,
    });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion: CURRENT_KEY_VERSION,
    };
  }

  decrypt(encrypted: EncryptedToken): Result<string, "needs_reset"> {
    try {
      const key = this.key(encrypted.keyVersion);
      const iv = decode(encrypted.iv, IV_BYTES);
      const tag = decode(encrypted.authTag, TAG_BYTES);
      const ciphertext = decode(encrypted.ciphertext);
      if (!key || !iv || !tag || !ciphertext || ciphertext.length === 0) {
        return err("needs_reset");
      }
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return ok(plain.toString("utf8"));
    } catch {
      // GCM auth failure (rotated secret, tampering). Fail closed, never crash.
      return err("needs_reset");
    }
  }
}

/**
 * One `AesGcmTokenCipher` per settings secret kind, each with its own HKDF info
 * (`agent-ops:slack-user-token:v1`, ...). An unknown kind throws: it is a programming error.
 */
export function createSecretCiphers(options: { secret: string }): SecretCiphers {
  const ciphers = new Map<SecretKind, TokenCipher>(
    SECRET_KINDS.map((kind) => [
      kind,
      new AesGcmTokenCipher({ secret: options.secret, purpose: secretKeyPurpose(kind) }),
    ]),
  );
  return (kind) => {
    const cipher = ciphers.get(kind);
    if (!cipher) throw new Error("createSecretCiphers: unknown secret kind");
    return cipher;
  };
}
