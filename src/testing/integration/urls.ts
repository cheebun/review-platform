/** Test connection strings, as resolved by global setup. Never log these. */
function required(name: "TEST_DATABASE_URL" | "TEST_REDIS_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (integration global setup did not run?)`);
  return value;
}

export const testPgUrl = () => required("TEST_DATABASE_URL");
export const testRedisUrl = () => required("TEST_REDIS_URL");
