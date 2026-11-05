import { http, HttpResponse } from "msw";
import type { SlackChannel } from "../../../ports/slack";
import { server } from "../server";
import { authTestOk, platformError } from "./fixtures";
import type { FailureKind, SlackWorld } from "./slack-world";

export const SLACK_API = "https://slack.com/api/";

async function readParams(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  const raw = await request.text();
  if (type.includes("application/json")) {
    const json = JSON.parse(raw || "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, String(v)]));
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * A stateful msw stand-in for slack.com/api that behaves like Slack (pagination, error shapes),
 * so `WebApiSlack` is exercised over real HTTP.
 */
export function createSlackMsw(): SlackWorld {
  let channelList: SlackChannel[] = [];
  let pending: { kind: FailureKind; retryAfterS: number } | null = null;

  const json = (body: unknown, init?: ResponseInit) => HttpResponse.json(body as never, init);

  server.use(
    http.post(`${SLACK_API}:method`, async ({ request, params }) => {
      const method = String(params.method);
      if (pending) {
        const { kind, retryAfterS } = pending;
        pending = null;
        if (kind === "rate_limited")
          return json(
            { ok: false, error: "ratelimited" },
            {
              status: 429,
              headers: { "Retry-After": String(retryAfterS) },
            },
          );
        if (kind === "auth") return json(platformError("invalid_auth"));
        return json({ error: "internal" }, { status: 500 });
      }
      const p = await readParams(request);
      switch (method) {
        case "auth.test":
          return json(authTestOk);
        case "conversations.list": {
          const start = p.cursor ? Number(p.cursor) : 0;
          const limit = Number(p.limit ?? 100);
          const end = start + limit;
          return json({
            ok: true,
            channels: channelList.slice(start, end).map((c) => ({
              id: c.id,
              name: c.name,
              is_channel: !c.isPrivate,
              is_group: c.isPrivate,
              is_private: c.isPrivate,
              is_archived: c.isArchived,
              is_member: c.isMember,
            })),
            response_metadata: { next_cursor: end < channelList.length ? String(end) : "" },
          });
        }
        default:
          return json(platformError("unknown_method"), { status: 404 });
      }
    }),
  );

  return {
    seedChannelList: (list) => void (channelList = list.map((c) => ({ ...c }))),
    failNext: (kind, opts) => void (pending = { kind, retryAfterS: opts?.retryAfterS ?? 1 }),
  };
}
