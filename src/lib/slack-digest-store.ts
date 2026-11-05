import type { DigestMessage } from "./slack-digest-capture";
import { createRedis, REDIS_UNLOCK_SCRIPT } from "./slack-review-redis";
import {
  digestItemKeys,
  type DigestItem,
  type SlackDigest,
  type SlackDigestMeta,
} from "./slack-digest-types";

export {
  DIGEST_CATEGORIES,
  type DigestItem,
  type SlackDigest,
  type SlackDigestMeta,
} from "./slack-digest-types";

export interface SlackDigestStore {
  append(message: DigestMessage): Promise<void>;
  /** Messages with from < ts <= to, deduplicated and sorted by time. */
  messages(fromMs: number, toMs: number): Promise<DigestMessage[]>;
  /** When live capture started; earlier messages must come from search. */
  captureSince(): Promise<number | null>;
  save(digest: SlackDigest): Promise<void>;
  list(limit: number): Promise<SlackDigestMeta[]>;
  get(id: string): Promise<SlackDigest | null>;
  /** Digests generated at or before this time are hidden from the workbench. */
  readBefore(): Promise<number | null>;
  markRead(atMs: number): Promise<void>;
  /** Item keys (see `digestItemKey`) of one digest hidden one by one. */
  readItems(id: string): Promise<string[]>;
  markItemRead(id: string, item: string): Promise<void>;
  lock(token: string, ttlMs: number): Promise<boolean>;
  unlock(token: string): Promise<void>;
}

const PREFIX = "agent-ops:slack-digest";
const MESSAGE_TTL_SECONDS = 14 * 24 * 60 * 60;
const DIGEST_TTL_SECONDS = 60 * 24 * 60 * 60;
const PAGE = 500;
const key = {
  day: (day: string) => `${PREFIX}:messages:${day}`,
  digest: (id: string) => `${PREFIX}:digest:${id}`,
  digests: `${PREFIX}:digests`,
  captureSince: `${PREFIX}:capture-since`,
  readBefore: `${PREFIX}:read-before`,
  readItems: (id: string) => `${PREFIX}:read-items:${id}`,
  lock: `${PREFIX}:lock`,
};

/** UTC+8 calendar day, used to bucket messages. */
export function digestDay(epochMs: number) {
  return new Date(epochMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function digestDaysBetween(fromMs: number, toMs: number) {
  const days: string[] = [];
  for (let at = fromMs; ; at += 24 * 60 * 60 * 1000) {
    const day = digestDay(Math.min(at, toMs));
    if (days.at(-1) !== day) days.push(day);
    if (at >= toMs) break;
  }
  return days;
}

/** The most recent full day ending at 09:00 UTC+8. */
export function digestWindow(nowMs: number) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const local = nowMs + 8 * hour;
  let end = Math.floor(local / day) * day + 9 * hour;
  if (end > local) end -= day;
  return { from: end - day - 8 * hour, to: end - 8 * hour };
}

/** Earlier entries win on duplicates, so live captures take precedence over search results. */
export function selectDigestMessages(messages: DigestMessage[], fromMs: number, toMs: number) {
  const seen = new Set<string>();
  return messages
    .filter((message) => {
      const at = Number(message.ts) * 1000;
      const id = `${message.channel}:${message.ts}`;
      if (at <= fromMs || at > toMs || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

type LegacyItem = Partial<DigestItem> & { detail?: string };

/** Older digests used `actionItems`, then `direct`/`team` with a single `detail` line. */
export function normalizeDigest(raw: Record<string, unknown>): SlackDigest {
  const items = (value: unknown) =>
    (Array.isArray(value) ? (value as LegacyItem[]) : []).map(
      ({ detail, ...item }) => ({ ...item, context: item.context ?? detail ?? "" }) as DigestItem,
    );
  return {
    botMergedCount: 0,
    warnings: [],
    sections: [],
    ...raw,
    todo: items(raw.todo ?? raw.actionItems),
    related: items(raw.related ?? raw.direct),
    teamTodo: items(raw.teamTodo),
    teamWatch: items(raw.teamWatch ?? raw.team),
  } as unknown as SlackDigest;
}

/** The latest digest and its read items, unless it was marked read as a whole or item by item. */
export async function unreadSlackDigest(
  store: Pick<SlackDigestStore, "list" | "get" | "readBefore" | "readItems">,
) {
  const [[latest], before] = await Promise.all([store.list(1), store.readBefore()]);
  if (!latest || Date.parse(latest.generatedAt) <= (before ?? 0)) return null;
  const [digest, readItems] = await Promise.all([store.get(latest.id), store.readItems(latest.id)]);
  if (!digest) return null;
  const keys = digestItemKeys(digest);
  if (keys.length && keys.every((item) => readItems.includes(item))) return null;
  return { digest, readItems };
}

export function createSlackDigestStore(): SlackDigestStore {
  const redis = createRedis();
  return {
    async append(message) {
      const pipeline = redis.pipeline();
      const at = Number(message.ts) * 1000;
      const day = key.day(digestDay(at));
      pipeline.rpush(day, JSON.stringify(message));
      pipeline.expire(day, MESSAGE_TTL_SECONDS);
      pipeline.set(key.captureSince, String(at), { nx: true });
      await pipeline.exec();
    },
    async messages(fromMs, toMs) {
      const all: DigestMessage[] = [];
      for (const day of digestDaysBetween(fromMs, toMs)) {
        for (let start = 0; ; start += PAGE) {
          const page = await redis.lrange(key.day(day), start, start + PAGE - 1);
          for (const raw of page) all.push(JSON.parse(raw) as DigestMessage);
          if (page.length < PAGE) break;
        }
      }
      return selectDigestMessages(all, fromMs, toMs);
    },
    async captureSince() {
      const value = await redis.get(key.captureSince);
      return typeof value === "string" ? Number(value) : null;
    },
    async save(digest) {
      const pipeline = redis.multi();
      pipeline.set(key.digest(digest.id), JSON.stringify(digest), { ex: DIGEST_TTL_SECONDS });
      pipeline.zadd(key.digests, {
        score: Date.parse(digest.generatedAt),
        member: JSON.stringify({
          id: digest.id,
          from: digest.from,
          to: digest.to,
          generatedAt: digest.generatedAt,
          messageCount: digest.messageCount,
        } satisfies SlackDigestMeta),
      });
      pipeline.zremrangebyscore(key.digests, 0, Date.now() - DIGEST_TTL_SECONDS * 1000);
      await pipeline.exec();
    },
    async list(limit) {
      const raws = await redis.zrange<string[]>(key.digests, 0, limit - 1, { rev: true });
      return raws.map((raw) => JSON.parse(raw) as SlackDigestMeta);
    },
    async get(id) {
      const raw = await redis.get(key.digest(id));
      return typeof raw === "string" ? normalizeDigest(JSON.parse(raw)) : null;
    },
    async readBefore() {
      const value = await redis.get(key.readBefore);
      return typeof value === "string" ? Number(value) : null;
    },
    async markRead(atMs) {
      await redis.set(key.readBefore, String(atMs));
    },
    async readItems(id) {
      return redis.smembers(key.readItems(id));
    },
    async markItemRead(id, item) {
      const pipeline = redis.multi();
      pipeline.sadd(key.readItems(id), item);
      pipeline.expire(key.readItems(id), DIGEST_TTL_SECONDS);
      await pipeline.exec();
    },
    async lock(token, ttlMs) {
      return (await redis.set(key.lock, token, { nx: true, px: ttlMs })) === "OK";
    },
    async unlock(token) {
      await redis.eval(REDIS_UNLOCK_SCRIPT, [key.lock], [token]);
    },
  };
}
