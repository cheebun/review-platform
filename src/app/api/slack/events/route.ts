import { NextResponse } from "next/server";
import { captureDigestMessage } from "@/lib/slack-digest-capture";
import { createSlackDigestStore } from "@/lib/slack-digest-store";
import { matchSlackReviewMessage } from "@/lib/slack-review-rules";
import { newSlackReviewJob } from "@/lib/slack-review-queue";
import { scheduleSlackReviewQueue, slackIdentity, slackReviewRuntime } from "@/lib/slack-review-vercel";
import { verifySlackSignature } from "@/lib/slack-signature";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Slack Events API endpoint; replaces the Socket Mode worker on Vercel.
 * The `release` Preview deployment sits behind Vercel Authentication, so Slack reaches this route only via
 * `?x-vercel-protection-bypass=<secret>` in the Request URL; the Slack signature is the access check here.
 */
export async function POST(request: Request) {
  const secret = process.env.SLACK_SIGNING_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "缺少 SLACK_SIGNING_SECRET" }, { status: 503 });
  const body = await request.text();
  if (!verifySlackSignature({
    secret, body,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
  })) {
    return NextResponse.json({ error: "签名无效" }, { status: 401 });
  }
  let payload: { type?: unknown; challenge?: unknown };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return NextResponse.json({ error: "请求体无效" }, { status: 400 });
  }
  if (payload.type === "url_verification") return NextResponse.json({ challenge: payload.challenge });

  try {
    const runtime = slackReviewRuntime();
    const identity = await slackIdentity(runtime.slack);
    // Duplicates from Slack retries are removed when the digest reads messages back.
    const captured = captureDigestMessage(payload, identity);
    if (captured) await createSlackDigestStore().append(captured);
    const message = matchSlackReviewMessage(payload, {
      ...identity,
      channelIds: runtime.config.channelIds,
      activeHours: runtime.config.activeHours,
    });
    if (message) {
      // Slack retries reuse the same message id; the queue lock prevents a second concurrent run.
      const created = await runtime.queue.create(newSlackReviewJob(message, runtime.config.account));
      if (created) {
        try {
          await runtime.dependencies.reply?.(message.channel, message.ts, message.threadTs);
        } catch (error) {
          console.error("[slack-review] on it 回复失败：", error instanceof Error ? error.message : "未知错误");
        }
      }
      scheduleSlackReviewQueue(runtime, message.id);
    }
    return new Response(null, { status: 200 });
  } catch (error) {
    // A non-2xx response makes Slack retry the event.
    console.error("[slack-review] 事件处理失败：", error instanceof Error ? error.message : "未知错误");
    return NextResponse.json({ error: "事件处理失败" }, { status: 500 });
  }
}
