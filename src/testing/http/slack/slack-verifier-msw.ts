import { http, HttpResponse } from "msw";
import type { SlackChannel, SlackIdentity } from "../../../ports/slack";
import type {
  SlackVerifierFailure,
  SlackVerifierWorld,
} from "../../contracts/slack-verifier.contract";
import { server } from "../server";
import { platformError, SLACK_TEAM_URL } from "./fixtures";
import { SLACK_API } from "./slack-msw";

const bearer = (request: Request): string =>
  (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");

const json = (body: unknown, init?: ResponseInit) => HttpResponse.json(body as never, init);

/**
 * slack.com/api as `/settings` sees it, over real HTTP: the token comes from the Authorization
 * header, like Slack. Unknown tokens get `invalid_auth`.
 */
export function createSlackVerifierMsw(): SlackVerifierWorld {
  const users = new Map<string, { identity: Partial<SlackIdentity>; bot: boolean }>();
  const lists = new Map<string, SlackChannel[]>();
  let pending: SlackVerifierFailure | null = null;

  server.use(
    http.post(`${SLACK_API}:method`, async ({ request, params }) => {
      if (pending) {
        const kind = pending;
        pending = null;
        if (kind === "rate_limited") {
          return json(
            { ok: false, error: "ratelimited" },
            { status: 429, headers: { "Retry-After": "1" } },
          );
        }
        if (kind === "auth") return json(platformError("invalid_auth"));
        return json({ error: "internal" }, { status: 500 });
      }
      const token = bearer(request);
      const body = new URLSearchParams(await request.text());
      switch (String(params.method)) {
        case "auth.test": {
          const u = users.get(token);
          if (!u) return json(platformError("invalid_auth"));
          return json({
            ok: true,
            url: u.identity.teamUrl ?? SLACK_TEAM_URL,
            team: u.identity.teamName ?? "Acme",
            user: u.identity.userName ?? "me",
            team_id: u.identity.teamId ?? "T1",
            user_id: u.identity.userId ?? "U1",
            ...(u.bot ? { bot_id: "B1" } : {}),
          });
        }
        case "conversations.list": {
          if (!users.has(token)) return json(platformError("invalid_auth"));
          const list = lists.get(token) ?? [];
          const start = body.get("cursor") ? Number(body.get("cursor")) : 0;
          const end = start + Number(body.get("limit") ?? 100);
          return json({
            ok: true,
            channels: list.slice(start, end).map((c) => ({
              id: c.id,
              name: c.name,
              is_private: c.isPrivate,
              is_archived: c.isArchived,
              is_member: c.isMember,
            })),
            response_metadata: { next_cursor: end < list.length ? String(end) : "" },
          });
        }
        default:
          return json(platformError("unknown_method"), { status: 404 });
      }
    }),
  );

  return {
    userToken: (token, identity = {}) => void users.set(token, { identity, bot: false }),
    botToken: (token) => void users.set(token, { identity: {}, bot: true }),
    channels: (token, list) => void lists.set(token, [...list]),
    failNext: (kind) => void (pending = kind),
  };
}
