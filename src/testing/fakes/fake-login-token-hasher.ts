import type { LoginTokenHasher } from "../../ports/login-token-hasher";
import { LOGIN_TOKEN_HASH_PREFIX } from "../../ports/login-token-store";

/**
 * Fast stand-in for PBKDF2 (600000 iterations is far too slow for unit tests). The encoding keeps
 * the real prefix, so the login token stores accept it. Not a hash: tests only.
 */
export class FakeLoginTokenHasher implements LoginTokenHasher {
  private salt = 0;

  async hash(token: string): Promise<string> {
    if (typeof token !== "string" || token.length === 0) throw new Error("empty token");
    this.salt += 1;
    return `${LOGIN_TOKEN_HASH_PREFIX}fake$${this.salt}$${Buffer.from(token).toString("base64url")}`;
  }

  async verify(token: string, encoded: string): Promise<boolean> {
    const encodedToken = encoded.split("$")[3];
    return encodedToken !== undefined && Buffer.from(token).toString("base64url") === encodedToken;
  }
}
