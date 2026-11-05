import { Redis } from "@upstash/redis";
import type { SlackReviewQueue } from "./slack-review-queue";
import type { SlackReviewJob } from "./slack-review-store";

const PREFIX = "agent-ops:slack-review";
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;
const RECENT_LIMIT = 200;
const key = {
  job: (id: string) => `${PREFIX}:job:${id}`,
  lock: (id: string) => `${PREFIX}:lock:${id}`,
  throttle: (name: string) => `${PREFIX}:throttle:${name}`,
  pending: `${PREFIX}:pending`,
  recent: `${PREFIX}:recent`,
  readBefore: `${PREFIX}:read-before`,
  readJobs: `${PREFIX}:read-jobs`,
};

const CREATE = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "EX", ARGV[4]) then
  redis.call("SADD", KEYS[2], ARGV[2])
  redis.call("ZADD", KEYS[3], ARGV[3], ARGV[2])
  redis.call("ZREMRANGEBYRANK", KEYS[3], 0, -${RECENT_LIMIT + 1})
  return 1
end
return 0`;

export function slackReviewRedisConfigured() {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)?.trim() &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)?.trim(),
  );
}

/** Vercel Marketplace Upstash injects KV_REST_API_*; a direct Upstash database uses UPSTASH_REDIS_REST_*. */
export function createRedis() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)?.trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)?.trim();
  if (!url || !token)
    throw new Error("缺少 Upstash Redis 配置（KV_REST_API_URL / KV_REST_API_TOKEN）。");
  return new Redis({ url, token, automaticDeserialization: false });
}

export const REDIS_UNLOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0`;

export function createSlackReviewRedisQueue(): SlackReviewQueue {
  const redis = createRedis();
  const parse = (raw: unknown) =>
    typeof raw === "string" ? (JSON.parse(raw) as SlackReviewJob) : null;
  const load = async (ids: string[]) => {
    if (!ids.length) return [];
    const raws = await redis.mget<unknown[]>(...ids.map(key.job));
    return raws.map(parse).filter((job): job is SlackReviewJob => Boolean(job));
  };

  return {
    async create(job) {
      const created = await redis.eval<string[], number>(
        CREATE,
        [key.job(job.id), key.pending, key.recent],
        [JSON.stringify(job), job.id, String(Date.parse(job.createdAt)), String(JOB_TTL_SECONDS)],
      );
      return Number(created) === 1;
    },
    async get(id) {
      return parse(await redis.get(key.job(id)));
    },
    async save(job) {
      const pipeline = redis.multi();
      pipeline.set(key.job(job.id), JSON.stringify(job), { ex: JOB_TTL_SECONDS });
      if (job.status === "done" || job.status === "failed") pipeline.srem(key.pending, job.id);
      else pipeline.sadd(key.pending, job.id);
      await pipeline.exec();
    },
    async pending() {
      const ids = await redis.smembers(key.pending);
      const jobs = await load(ids);
      const expired = ids.filter((id) => !jobs.some((job) => job.id === id));
      if (expired.length) await redis.srem(key.pending, ...expired);
      return jobs;
    },
    async recent(limit) {
      return load(await redis.zrange<string[]>(key.recent, 0, limit - 1, { rev: true }));
    },
    async lock(id, owner, ttlMs) {
      return (await redis.set(key.lock(id), owner, { nx: true, px: ttlMs })) === "OK";
    },
    async unlock(id, owner) {
      await redis.eval(REDIS_UNLOCK_SCRIPT, [key.lock(id)], [owner]);
    },
    async throttle(name, seconds) {
      return (await redis.set(key.throttle(name), "1", { nx: true, ex: seconds })) === "OK";
    },
    async readBefore() {
      const value = await redis.get(key.readBefore);
      return typeof value === "string" ? value : null;
    },
    async markRead(at) {
      await redis.set(key.readBefore, at);
    },
    async readJobs() {
      return redis.smembers(key.readJobs);
    },
    async markJobRead(id) {
      const pipeline = redis.multi();
      pipeline.sadd(key.readJobs, id);
      pipeline.expire(key.readJobs, JOB_TTL_SECONDS);
      await pipeline.exec();
    },
  };
}
