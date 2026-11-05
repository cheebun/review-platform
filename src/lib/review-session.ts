import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { GithubAccount } from "./accounts";
import { ReviewDeferredError } from "./review-input";
import { createRedis, REDIS_UNLOCK_SCRIPT, slackReviewRedisConfigured } from "./slack-review-redis";
import { shipPullRequest, type ShipProgress } from "./ship-pr";
import type { ExecuteResult } from "./types";

const TTL_SECONDS = 24 * 60 * 60;
const LOCK_MS = 330_000;
type ReviewSession = {
  url: string;
  account: GithubAccount;
  expiresAt: number;
  progress: ShipProgress;
  result?: ExecuteResult;
};

export interface ReviewSessionStore {
  get(id: string): Promise<ReviewSession | null>;
  save(id: string, session: ReviewSession): Promise<void>;
  acquire(id: string): Promise<(() => Promise<void>) | null>;
}

/** Session contents stay on the server; the browser only receives an opaque ID. */
export function createReviewSessionStore(): ReviewSessionStore {
  if (slackReviewRedisConfigured()) {
    const redis = createRedis();
    const key = (id: string) => `agent-ops:review-session:${id}`;
    return {
      async get(id) {
        const raw = await redis.get<string>(key(id));
        return raw ? (JSON.parse(raw) as ReviewSession) : null;
      },
      async save(id, session) {
        await redis.set(key(id), JSON.stringify(session), { ex: TTL_SECONDS });
      },
      async acquire(id) {
        const token = randomUUID();
        const lockKey = `${key(id)}:lock`;
        if ((await redis.set(lockKey, token, { nx: true, px: LOCK_MS })) !== "OK") return null;
        return async () => {
          await redis.eval(REDIS_UNLOCK_SCRIPT, [lockKey], [token]);
        };
      },
    };
  }
  const directory = join(process.cwd(), ".agent-ops", "review-sessions");
  const file = (id: string) => join(directory, `${id}.json`);
  return {
    async get(id) {
      try {
        return JSON.parse(await readFile(file(id), "utf8")) as ReviewSession;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async save(id, session) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file(id)}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(session), { mode: 0o600 });
      await rename(temporary, file(id));
    },
    async acquire(id) {
      try {
        return await lock(file(id), { realpath: false, stale: LOCK_MS, update: 30_000 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOCKED") return null;
        throw error;
      }
    },
  };
}

export async function runReviewSession(options: {
  url: string;
  account: GithubAccount;
  sessionId?: string;
  startReviewBefore: number;
  store?: ReviewSessionStore;
  ship?: typeof shipPullRequest;
}) {
  const { url, account } = options;
  const id = options.sessionId ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
    throw new Error("审查会话 ID 无效。");
  }
  const store = options.store ?? createReviewSessionStore();
  if (!options.sessionId) {
    await store.save(id, {
      url,
      account,
      expiresAt: Date.now() + TTL_SECONDS * 1000,
      progress: {},
    });
  }
  const pending = { pending: true as const, sessionId: id };
  const release = await store.acquire(id);
  if (!release) return pending;
  try {
    const session = await store.get(id);
    if (
      !session ||
      session.expiresAt < Date.now() ||
      session.url !== url ||
      session.account !== account
    ) {
      throw new Error("审查会话不存在、已过期或与当前 PR / 账号不匹配，请重新发起 Review。");
    }
    if (session.result) return { pending: false as const, result: session.result };
    try {
      session.result = await (options.ship ?? shipPullRequest)(url, account, {
        progress: session.progress,
        requestId: `ui:${id}`,
        startReviewBefore: options.startReviewBefore,
        checkpoint: async (progress) => {
          session.progress = progress;
          await store.save(id, session);
        },
      });
      await store.save(id, session);
      return { pending: false as const, result: session.result };
    } catch (error) {
      if (error instanceof ReviewDeferredError) return pending;
      throw error;
    }
  } finally {
    await release();
  }
}
