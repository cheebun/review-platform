import { defineScript } from "redis";

/** Compare-and-delete: removes the key only while it still holds the caller's token. */
const LOCK_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Compare-and-extend: resets the TTL only while the key still holds the caller's token. */
const LOCK_EXTEND = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * Sliding window over a sorted set, atomic in one script.
 * KEYS[1] = window key. ARGV = now(ms), windowMs, limit, member, keyTtlMs.
 * Returns {allowed(0|1), remaining, retryAfterMs}. Blocked hits are never added.
 */
const RATE_LIMIT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = tonumber(oldest[2]) + window - now
if retry < 1 then retry = 1 end
return {0, 0, retry}
`;

/**
 * Failed-attempt counter with a lockout, atomic in one script (`RedisAttemptLimiter`).
 * KEYS[1] = counter key. ARGV = limit, windowMs, lockoutMs.
 * Returns {allowed(0|1), retryAfterMs}. A refused attempt is not counted and keeps the TTL.
 */
const ATTEMPT_LIMIT = `
local limit = tonumber(ARGV[1])
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= limit then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[3])
    ttl = tonumber(ARGV[3])
  end
  if ttl < 1 then ttl = 1 end
  return {0, ttl}
end
count = redis.call('INCR', KEYS[1])
if count >= limit then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
elseif count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return {1, 0}
`;

export const scripts = {
  lockRelease: defineScript({
    NUMBER_OF_KEYS: 1,
    SCRIPT: LOCK_RELEASE,
    parseCommand(parser, key: string, token: string) {
      parser.pushKey(key);
      parser.push(token);
    },
    transformReply: undefined as unknown as () => number,
  }),
  lockExtend: defineScript({
    NUMBER_OF_KEYS: 1,
    SCRIPT: LOCK_EXTEND,
    parseCommand(parser, key: string, token: string, ttlMs: number) {
      parser.pushKey(key);
      parser.push(token, String(ttlMs));
    },
    transformReply: undefined as unknown as () => number,
  }),
  rateLimit: defineScript({
    NUMBER_OF_KEYS: 1,
    SCRIPT: RATE_LIMIT,
    parseCommand(
      parser,
      key: string,
      nowMs: number,
      windowMs: number,
      limit: number,
      member: string,
      keyTtlMs: number,
    ) {
      parser.pushKey(key);
      parser.push(String(nowMs), String(windowMs), String(limit), member, String(keyTtlMs));
    },
    transformReply: undefined as unknown as () => number[],
  }),
  attemptLimit: defineScript({
    NUMBER_OF_KEYS: 1,
    SCRIPT: ATTEMPT_LIMIT,
    parseCommand(parser, key: string, limit: number, windowMs: number, lockoutMs: number) {
      parser.pushKey(key);
      parser.push(String(limit), String(windowMs), String(lockoutMs));
    },
    transformReply: undefined as unknown as () => number[],
  }),
};
