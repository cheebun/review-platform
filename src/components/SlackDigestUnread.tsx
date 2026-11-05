"use client";

import { ArrowRightOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { Button } from "antd";
import Link from "next/link";
import { useEffect, useState } from "react";
import { StatusPill } from "@/components/StatusPill";
import { DigestCategories, digestStats, windowLabel } from "@/components/SlackDigestParts";
import { digestItemKeys, type SlackDigest } from "@/lib/slack-digest-types";

const postRead = async (body: object) => {
  const response = await fetch("/api/slack/digest/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("标记已读失败");
};

/** Workbench module: the latest digest until it is marked read, as a whole or item by item. */
export function SlackDigestUnread() {
  const [digest, setDigest] = useState<SlackDigest | null>(null);
  const [readItems, setReadItems] = useState<string[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [marking, setMarking] = useState(false);
  const [reading, setReading] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/slack/digest?unread=1", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("读取日报失败");
        const body = await response.json() as { digest: SlackDigest | null; readItems?: string[] };
        setDigest(body.digest);
        setReadItems(body.readItems ?? []);
        setState("ready");
      })
      .catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, []);

  const markAllRead = async () => {
    if (!digest) return;
    setMarking(true);
    try {
      await postRead({ generatedAt: digest.generatedAt });
      setDigest(null);
    } catch {
      setState("error");
    } finally {
      setMarking(false);
    }
  };

  const markItemRead = async (item: string) => {
    if (!digest) return;
    setReading(item);
    try {
      await postRead({ id: digest.id, item });
      const next = [...readItems, item];
      setReadItems(next);
      if (digestItemKeys(digest).every((key) => next.includes(key))) setDigest(null);
    } catch {
      setState("error");
    } finally {
      setReading(null);
    }
  };

  const unread = digest ? digestItemKeys(digest).filter((key) => !readItems.includes(key)).length : 0;
  return (
    <section className="slack-review-status">
      <div className="slack-review-status-head">
        <Link href="/slack" className="workbench-module-title">Slack 日报 <ArrowRightOutlined /></Link>
        {state === "error" ? <StatusPill tone="warning">读取失败</StatusPill> : null}
        {unread ? <StatusPill tone="info">{unread} 条未读</StatusPill> : null}
        {digest ? <span className="ops-desc" style={{ margin: 0 }}>{windowLabel(digest.from, digest.to)}</span> : null}
        {digest ? (
          <Button
            color="green" variant="solid" icon={<CheckCircleOutlined />}
            className="read-all-button" loading={marking} onClick={() => void markAllRead()}
          >
            全部已读
          </Button>
        ) : null}
      </div>
      {state === "loading" ? <p className="ops-desc" style={{ margin: 0 }}>读取中…</p> : null}
      {state === "ready" && !digest ? (
        <p className="ops-desc" style={{ margin: 0 }}>没有未读日报，下一份在每天 09:00（UTC+8）生成。</p>
      ) : null}
      {digest ? (
        <div className="digest">
          <p className="digest-stats" style={{ margin: 0 }}>{digestStats(digest)}</p>
          <DigestCategories digest={digest} readItems={readItems} onRead={(item) => void markItemRead(item)} reading={reading} />
        </div>
      ) : null}
    </section>
  );
}
