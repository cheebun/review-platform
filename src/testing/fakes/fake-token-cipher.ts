import { err, ok, type Result } from "../../domain/shared/result";
import type { EncryptedToken, TokenCipher } from "../../ports/token-cipher";

/**
 * Reversible, keyed obfuscation standing in for AES-GCM in unit tests. The stored fields never
 * contain the plaintext. `rotate()` simulates a changed BETTER_AUTH_SECRET: every earlier
 * ciphertext then fails to decrypt.
 */
export class FakeTokenCipher implements TokenCipher {
  private key = 1;
  private counter = 0;

  rotate(): void {
    this.key += 1;
  }

  encrypt(plaintext: string): EncryptedToken {
    this.counter += 1;
    const reversed = [...plaintext].toReversed().join("");
    return {
      ciphertext: Buffer.from(reversed, "utf8").toString("base64"),
      iv: Buffer.from(`iv-${this.counter}`).toString("base64"),
      authTag: Buffer.from(`k${this.key}`).toString("base64"),
      keyVersion: 1,
    };
  }

  decrypt(encrypted: EncryptedToken): Result<string, "needs_reset"> {
    if (Buffer.from(encrypted.authTag, "base64").toString() !== `k${this.key}`) {
      return err("needs_reset");
    }
    const reversed = Buffer.from(encrypted.ciphertext, "base64").toString("utf8");
    return ok([...reversed].toReversed().join(""));
  }
}
