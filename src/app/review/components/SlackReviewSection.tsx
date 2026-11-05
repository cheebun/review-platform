"use client";

import { useReviewPageContext } from "./ReviewPageProvider";
import { SlackReviewStatus } from "./SlackReviewStatus";

export function SlackReviewSection({ href }: { href?: string }) {
  const { runShip, busy, runningUrl } = useReviewPageContext();
  return <SlackReviewStatus href={href} onShip={runShip} busy={busy} runningUrl={runningUrl} />;
}
