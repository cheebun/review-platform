import { NextResponse } from "next/server";
import { isFinishedSlackReviewJob, visibleSlackReviewJobs } from "@/lib/slack-review-queue";
import { createSlackReviewRedisQueue, slackReviewRedisConfigured } from "@/lib/slack-review-redis";
import { SLACK_REVIEW_ACTIVE_HOURS, withinActiveHours } from "@/lib/slack-review-rules";
import { readSlackReviewState, type SlackReviewJob } from "@/lib/slack-review-store";
import { scheduleSlackReviewQueue, slackReviewRuntime } from "@/lib/slack-review-vercel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const noStore = { "Cache-Control": "no-store" };
const summarize = (jobs: SlackReviewJob[]) => jobs.map((job) => ({
  id: job.id, status: job.status, urls: job.urls, updatedAt: job.updatedAt, error: job.error,
}));
const hours = () => ({
  activeHours: SLACK_REVIEW_ACTIVE_HOURS,
  withinHours: withinActiveHours(Date.now(), SLACK_REVIEW_ACTIVE_HOURS),
});

export async function GET() {
  try {
    if (slackReviewRedisConfigured()) {
      let runtime;
      try {
        runtime = slackReviewRuntime();
      } catch (error) {
        return NextResponse.json({
          mode: "vercel", active: false, jobs: [], ...hours(),
          problem: error instanceof Error ? error.message : "Slack Review 配置无效",
        }, { headers: noStore });
      }
      const jobs = await visibleSlackReviewJobs(runtime.queue, 10);
      // Viewing the page also resumes interrupted jobs, since Hobby crons run only once a day.
      if (jobs.some((job) => !isFinishedSlackReviewJob(job)) && await runtime.queue.throttle("status-drain", 60)) {
        scheduleSlackReviewQueue(runtime);
      }
      return NextResponse.json({
        mode: "vercel",
        active: Boolean(process.env.SLACK_SIGNING_SECRET?.trim()),
        problem: process.env.SLACK_SIGNING_SECRET?.trim() ? undefined : "缺少 SLACK_SIGNING_SECRET",
        account: runtime.config.account,
        canMarkRead: true,
        jobs: summarize(jobs),
        ...hours(),
      }, { headers: noStore });
    }
    const state = await readSlackReviewState();
    const active = Boolean(state.worker?.connected &&
      Date.now() - Date.parse(state.worker.updatedAt) < 90_000);
    return NextResponse.json({
      mode: "local",
      active,
      account: state.worker?.account,
      canMarkRead: false,
      jobs: summarize(state.jobs.slice(-10).reverse()),
      ...hours(),
    }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "无法读取 Slack Review 状态" }, { status: 500 });
  }
}

/** Marks one finished job (`{ id }`) or every finished job as read, hiding it from the status list. */
export async function POST(request: Request) {
  if (!slackReviewRedisConfigured()) {
    return NextResponse.json({ error: "本地 worker 模式不支持已读" }, { status: 400 });
  }
  const body = await request.json().catch(() => null) as { id?: unknown } | null;
  try {
    const queue = createSlackReviewRedisQueue();
    if (typeof body?.id === "string") await queue.markJobRead(body.id);
    else await queue.markRead(new Date().toISOString());
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "标记已读失败" }, { status: 500 });
  }
}
