import { err, type Result } from "../domain/shared/result";

export type TokenScopedOptions<P> = {
  /** Named in the `upstream` error when the token cannot be read. */
  service: "github" | "slack";
  /** Reads the stored token (e.g. `resolveGithubToken`); its error is returned as is. */
  token: () => Promise<Result<string>>;
  /** Builds a client bound to one token. Called again only when the token changes. */
  build: (token: string) => P;
  /** Every method of `P`, so a new port method cannot be left undelegated. */
  methods: Record<keyof P, true>;
};

type AnyMethod = (...args: unknown[]) => Promise<Result<unknown>>;

/**
 * A port whose credential lives in the settings store and can change at any time without a
 * restart: every call reads the current token, then delegates to a client built for it (kept
 * while the token is unchanged). Every method of `P` must return a `Result`; an unconfigured
 * store gives its `not_configured` error, and a store that throws gives a retryable
 * `upstream` error (never the thrown error, which may carry a connection string).
 */
export function tokenScoped<P extends object>(options: TokenScopedOptions<P>): P {
  let cached: { token: string; client: P } | undefined;
  const client = (token: string): P => {
    if (cached?.token !== token) cached = { token, client: options.build(token) };
    return cached.client;
  };
  const port: Record<string, AnyMethod> = {};
  for (const name of Object.keys(options.methods)) {
    port[name] = async (...args) => {
      let token: Result<string>;
      try {
        token = await options.token();
      } catch {
        return err({ kind: "upstream", service: options.service, retryable: true });
      }
      if (!token.ok) return token;
      const target = client(token.value) as unknown as Record<string, AnyMethod>;
      return target[name]!.apply(target, args);
    };
  }
  return port as unknown as P;
}
