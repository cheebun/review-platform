import { NextResponse } from "next/server";
import { runSlackReviewQueue, slackReviewRuntime } from "@/lib/slack-review-vercel";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Daily Vercel Cron backstop for jobs interrupted while nobody had /review open. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }
  await runSlackReviewQueue(slackReviewRuntime());
  return NextResponse.json({ ok: true });
}
