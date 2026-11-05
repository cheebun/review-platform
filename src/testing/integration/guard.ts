type Env = Record<string, string | undefined>;

/**
 * Refuses to run against production. Error messages name the variables only,
 * never their values.
 */
export function assertNotProduction(env: Env): void {
  if (!env.TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is not set (expected in .env.test.local)");
  }
  if (env.DATABASE_URL && env.TEST_DATABASE_URL === env.DATABASE_URL) {
    throw new Error("Refusing to run: TEST_DATABASE_URL equals DATABASE_URL");
  }
  if (env.REDIS_URL && env.TEST_REDIS_URL && env.TEST_REDIS_URL === env.REDIS_URL) {
    throw new Error("Refusing to run: TEST_REDIS_URL equals REDIS_URL");
  }
}
