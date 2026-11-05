/**
 * Slack review wiring for the web process and the review worker. Every Slack credential
 * comes from the encrypted `SettingsStore` (never `SLACK_*` env): a missing secret turns its
 * entry point into a typed 503 `not_configured` (`slack_events`), with
 * `reason: "needs_reset"` when the stored row cannot be decrypted.
 *
 * The HTTP handlers live here (not in the route files) so they are tested with plain `Request`s.
 */
import { nodeSlackCrypto } from "../adapters/slack/node-crypto";
import { SlackMessenger } from "../adapters/slack/slack-messenger";
import type { ReviewUnitOfWork } from "../application/review/ports";
import type { ReactionDrainDeps } from "../application/review/reaction-drain";
import type { ReviewConsumerDeps } from "../application/review/review-job-consumer";
import type { ShipDeps } from "../application/ship/ship";
import { SlackCredentials, SLACK_SETTINGS_CHANGED_CHANNEL } from "../application/slack/credentials";
import { receiveSlackEvent, type SlackIngestDeps } from "../application/slack/ingest";
import { verifySlackRequest, type SlackVerifyDeps } from "../application/slack/verify";
import type { DomainError } from "../domain/shared/result";
import type { GitHubPort } from "../ports/github";
import type { ReactionOutbox } from "../ports/reaction-outbox";
import type { ReviewRecordRepo } from "../ports/review-record-repo";
import type { SettingsStore } from "../ports/settings-store";
import type { IdGenerator, Logger } from "../ports/system";
import type { ThreadReviewIndex } from "../ports/thread-review-index";
import type { Ports } from "./container";
import { toHttp, unexpectedToHttp, type HttpError } from "./errors";
import { realTimers } from "./workers/timers";

// ---------------------------------------------------------------------------
// Ports: what 3w adds to `Ports` (names fixed here)
// ---------------------------------------------------------------------------

/** The ports the Slack review needs on top of today's `Ports`. */
export type SlackReviewPorts = {
  settingsStore: SettingsStore;
  threadReviews: ThreadReviewIndex;
  reactionOutbox: ReactionOutbox;
  reviewRecords: ReviewRecordRepo;
  reviewUnitOfWork: ReviewUnitOfWork;
  github: GitHubPort;
};

export const SLACK_REVIEW_PORT_NAMES = [
  "settingsStore",
  "threadReviews",
  "reactionOutbox",
  "reviewRecords",
  "reviewUnitOfWork",
  "github",
] as const satisfies readonly (keyof SlackReviewPorts)[];

export type SlackReadyPorts = Ports & SlackReviewPorts;

/** The ports with the Slack review ones, or null until all of them are wired. */
export function slackReviewPorts(ports: Ports): SlackReadyPorts | null {
  const candidate = ports as Ports & Partial<SlackReviewPorts>;
  return SLACK_REVIEW_PORT_NAMES.every((name) => candidate[name] != null)
    ? (candidate as SlackReadyPorts)
    : null;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export type SlackServiceOptions = {
  /** Public base URL of the app, for the review links in the result replies. */
  appUrl: string;
  slackApiUrl?: string;
};

export type SlackServices = {
  credentials: SlackCredentials;
  messenger: SlackMessenger;
  verify: SlackVerifyDeps;
  ingest: SlackIngestDeps;
  consumer: ReviewConsumerDeps;
  reactions: ReactionDrainDeps;
  /** Drops the cached credentials whenever `/settings` saves a Slack secret. */
  watchSettings(): Promise<() => Promise<void>>;
};

export type SlackEventServices = Pick<SlackServices, "verify" | "ingest">;

export function createSlackServices(
  ports: SlackReadyPorts,
  opts: SlackServiceOptions,
): SlackServices {
  const { clock, logger } = ports;
  const credentials = new SlackCredentials({ settingsStore: ports.settingsStore, clock });
  const messenger = new SlackMessenger(
    () => credentials.userToken(),
    opts.slackApiUrl ? { slackApiUrl: opts.slackApiUrl } : {},
  );
  // The same ship deps as /merge and /review: one definition in the container.
  const review: ShipDeps = ports.shipDeps(ports.github);
  const consumer: ReviewConsumerDeps = {
    ...review,
    reviewer: ports.reviewer,
    replier: messenger,
    reviewLink: (id) => new URL(`/review/${encodeURIComponent(id)}`, opts.appUrl).toString(),
  };
  return {
    credentials,
    messenger,
    verify: {
      credentials,
      settingsStore: ports.settingsStore,
      crypto: nodeSlackCrypto,
      clock,
      logger,
    },
    ingest: {
      credentials,
      settingsStore: ports.settingsStore,
      eventDedupe: ports.eventDedupe,
      rateLimiter: ports.rateLimiter,
      wakeUp: ports.wakeUp,
      replier: messenger,
      review,
    },
    consumer,
    reactions: { outbox: ports.reactionOutbox, sender: messenger, timers: realTimers, logger },
    watchSettings: () =>
      ports.wakeUp.subscribe(SLACK_SETTINGS_CHANGED_CHANNEL, () => credentials.invalidate()),
  };
}

const memo = new WeakMap<Ports, SlackServices>();

/**
 * One `SlackServices` per container (so the credential cache is shared by every request), or
 * null while the review ports are not wired.
 */
export function slackServicesFor(ports: Ports, opts: SlackServiceOptions): SlackServices | null {
  const hit = memo.get(ports);
  if (hit) return hit;
  const ready = slackReviewPorts(ports);
  if (!ready) return null;
  const services = createSlackServices(ready, opts);
  memo.set(ports, services);
  services.watchSettings().catch((error: unknown) => {
    ports.logger.warn("slack settings watch not subscribed; the cache expires on its own", {
      error: error instanceof Error ? error.name : "unknown",
    });
  });
  return services;
}

// ---------------------------------------------------------------------------
// Feature status (replaces the env-based Slack credential environment settings)
// ---------------------------------------------------------------------------

export type SlackFeatureState = "ready" | "not_configured" | "needs_reset";

/** What each Slack entry point would do now, read from the settings store. */
export async function slackFeatureStatus(
  store: Pick<SettingsStore, "getSecret">,
): Promise<Record<"slack" | "slack_events", SlackFeatureState>> {
  const [user, signing] = await Promise.all([
    store.getSecret("slack_user_token"),
    store.getSecret("slack_signing_secret"),
  ]);
  return { slack: user.state, slack_events: signing.state };
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

const NO_STORE = { "cache-control": "no-store" };
/** Slack event payloads are small; anything larger is not from Slack. */
export const MAX_SLACK_BODY_BYTES = 1_000_000;

type HandlerContext = { ids: IdGenerator; logger: Logger };

function errorResponse(http: HttpError, extra: Record<string, unknown> = {}): Response {
  return Response.json(
    { error: http.body.message, ...http.body, ...extra },
    { status: http.status, headers: { ...NO_STORE, ...http.headers } },
  );
}

function fail(ctx: HandlerContext, error: DomainError): Response {
  // `feature` and `reason` are public facts of a 503, never secrets (FR-SETTINGS-01).
  const extra =
    error.kind === "not_configured"
      ? { feature: error.feature, ...(error.reason ? { reason: error.reason } : {}) }
      : {};
  return errorResponse(toHttp(error, ctx.ids.uuid()), extra);
}

function unexpected(ctx: HandlerContext, route: string, error: unknown): Response {
  const requestId = ctx.ids.uuid();
  ctx.logger.error("slack route failed", {
    route,
    requestId,
    error: error instanceof Error ? error.name : "unknown",
  });
  return errorResponse(unexpectedToHttp(error, requestId));
}

const isUrlVerification = (
  payload: unknown,
): payload is { type: "url_verification"; challenge: string } => {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { type?: unknown; challenge?: unknown };
  return (
    p.type === "url_verification" &&
    typeof p.challenge === "string" &&
    p.challenge.length > 0 &&
    p.challenge.length <= 500
  );
};

export type SlackEventsContext = HandlerContext & {
  services: SlackEventServices | null;
  /** Runs the work of an accepted event after the response. Default: fire and forget, logged. */
  schedule?: (work: () => Promise<void>) => void;
};

/**
 * FR-SLACK-01/02: verify the signature on the raw body, answer `url_verification`, claim the
 * event and ack at once; the work runs after the response.
 */
export async function handleSlackEvents(
  request: Request,
  ctx: SlackEventsContext,
): Promise<Response> {
  const route = "POST /api/slack/events";
  try {
    if (!ctx.services) return fail(ctx, { kind: "not_configured", feature: "slack_events" });
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_SLACK_BODY_BYTES) return tooLarge(ctx);
    const rawBody = await request.text();
    if (rawBody.length > MAX_SLACK_BODY_BYTES) return tooLarge(ctx);

    const verified = await verifySlackRequest(ctx.services.verify, {
      rawBody,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
    });
    if (!verified.ok) return fail(ctx, verified.error);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return fail(ctx, { kind: "validation", message: "Body is not JSON." });
    }
    if (isUrlVerification(payload)) {
      return Response.json({ challenge: payload.challenge }, { headers: NO_STORE });
    }

    const received = await receiveSlackEvent(ctx.services.ingest, payload);
    if (received.status === "retry") return unexpected(ctx, route, new Error("retry"));
    if (received.outcome === "accepted") {
      const schedule =
        ctx.schedule ??
        ((work: () => Promise<void>) => {
          void work().catch((error: unknown) => unexpected(ctx, route, error));
        });
      schedule(received.work);
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return unexpected(ctx, route, error);
  }
}

function tooLarge(ctx: HandlerContext): Response {
  return Response.json(
    {
      error: "The request is invalid.",
      kind: "validation",
      message: "The request is invalid.",
      requestId: ctx.ids.uuid(),
    },
    { status: 413, headers: NO_STORE },
  );
}
