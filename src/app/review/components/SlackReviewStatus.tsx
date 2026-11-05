"use client";

import { ArrowRightOutlined, CheckCircleOutlined, CheckOutlined, RocketOutlined } from "@ant-design/icons";
import { Button } from "antd";
import Link from "next/link";
import { useEffect, useState } from "react";
import { StatusPill } from "@/components/StatusPill";

type JobStatus = "queued" | "running" | "reaction_pending" | "done" | "failed";
type Status = {
  mode: "vercel" | "local";
  active: boolean;
  problem?: string;
  account?: string;
  canMarkRead?: boolean;
  activeHours: { start: number; end: number };
  withinHours: boolean;
  jobs: { id: string; status: JobStatus; urls: string[]; error?: string }[];
};
const LABELS: Record<JobStatus, string> = {
  queued: "等待执行", running: "Review 中", reaction_pending: "等待 Slack 回执", done: "已标记 ✅", failed: "执行失败",
};
const finished = (status: JobStatus) => status === "done" || status === "failed";
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/** `href` turns the title into a link, for use outside the PR Review page. */
export function SlackReviewStatus({ href, onShip, busy, runningUrl }: {
  href?: string;
  onShip: (url: string) => Promise<void>;
  busy: boolean;
  runningUrl: string | null;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  /** `true` while marking everything read, or the id of the job being marked. */
  const [marking, setMarking] = useState<boolean | string>(false);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/slack/review-status", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("状态读取失败");
        const next = await response.json() as Status;
        if (!controller.signal.aborted) { setStatus(next); setUnavailable(false); }
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);

  /** Without `id`, marks every finished job read. */
  const markRead = async (id?: string) => {
    setMarking(id ?? true);
    try {
      const response = await fetch("/api/slack/review-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id } : {}),
      });
      if (!response.ok) throw new Error("标记已读失败");
      setStatus((current) => current && {
        ...current,
        jobs: current.jobs.filter((job) => !finished(job.status) || (id !== undefined && job.id !== id)),
      });
    } catch {
      setUnavailable(true);
    } finally {
      setMarking(false);
    }
  };

  const listening = Boolean(status?.active && status.withinHours);
  const activeUrls = new Set(status?.jobs.filter((job) => !finished(job.status)).flatMap((job) => job.urls));
  const hours = status ? `${clock(status.activeHours.start)}–${clock(status.activeHours.end)}` : "";
  return (
    <section className="slack-review-status">
      <div className="slack-review-status-head">
        {href ? (
          <Link href={href} className="workbench-module-title">Slack 自动 Review <ArrowRightOutlined /></Link>
        ) : <strong>Slack 自动 Review</strong>}
        <StatusPill tone={unavailable ? "warning" : listening ? "success" : "muted"}>
          {unavailable ? "状态不可用" : !status ? "读取状态…" : !status.active ? "未启动" : listening ? "监听中" : "休息中"}
        </StatusPill>
        {status ? <span className="ops-desc" style={{ margin: 0 }}>
          {[status.mode === "vercel" ? "Vercel" : "本地 worker", status.account].filter(Boolean).join(" · ")}
        </span> : null}
        {status?.canMarkRead && status.jobs.some((job) => finished(job.status)) ? (
          <Button
            color="green" variant="solid" icon={<CheckCircleOutlined />}
            className="read-all-button" loading={marking === true} disabled={busy} onClick={() => void markRead()}
          >
            全部已读
          </Button>
        ) : null}
      </div>
      <p className="ops-desc" style={{ margin: 0 }}>
        白名单成员私信或 @你，并包含 katana-web PR 链接时自动 Ship；完成后在原消息标记 ✅。
        {hours ? ` 仅响应 UTC+8 ${hours} 发送的消息。` : null}
        {" PR 准备好后，可点击旁边的 Ship 重新审查。"}
      </p>
      {status && !status.active ? (
        <p className="ops-desc" style={{ margin: 0 }}>
          {status.problem ?? (status.mode === "vercel" ? "Vercel 上的 Slack 配置不完整。" : "Slack 监听进程尚未连接。")}
        </p>
      ) : null}
      {status?.jobs.length ? (
        <ul className="slack-review-jobs">
          {status.jobs.map((job) => (
            <li key={job.id}>
              <StatusPill tone={job.status === "failed" ? "danger" : job.status === "done" ? "success" : "info"}>
                {LABELS[job.status]}
              </StatusPill>
              {job.urls.map((url) => (
                <span className="slack-review-pr" key={url}>
                  <a href={url} target="_blank" rel="noopener noreferrer">#{url.split("/").pop()}</a>
                  <Button
                    size="small" type="primary" icon={<RocketOutlined />}
                    loading={runningUrl === url} disabled={busy || activeUrls.has(url)}
                    aria-label={`Ship PR #${url.split("/").pop()}`}
                    title={activeUrls.has(url) ? "自动任务仍在执行" : "审查 PR 的最新提交"}
                    onClick={() => {
                      if (!busy && !activeUrls.has(url)) void onShip(url);
                    }}
                  >
                    Ship
                  </Button>
                </span>
              ))}
              {job.error ? <span className="slack-review-error">{job.error}</span> : null}
              {status.canMarkRead && finished(job.status) ? (
                <Button
                  size="small" color="green" variant="filled" icon={<CheckOutlined />}
                  className="read-item-button" loading={marking === job.id} disabled={busy} onClick={() => void markRead(job.id)}
                >
                  已读
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : status && href ? <p className="ops-desc" style={{ margin: 0 }}>没有未读的执行记录。</p> : null}
    </section>
  );
}
