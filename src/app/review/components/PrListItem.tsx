"use client";

import { StatusPill, StatusPillGroup } from "@/components/StatusPill";
import {
  REVIEW_AUTHOR_LABELS,
  isOwnReviewAuthor,
  type ReviewAuthor,
} from "@/lib/repos";
import type { OpenPrItem } from "@/lib/types";
import {
  CopyOutlined,
  MergeCellsOutlined,
  RocketOutlined,
} from "@ant-design/icons";
import { Button } from "antd";
import { formatUpdatedAt } from "../lib/review-ui";
import { useReviewPageContext } from "./ReviewPageProvider";

export function PrListItem({ item }: { item: OpenPrItem }) {
  const { busy, runningUrl, mergingUrl, runShip, runMerge, copyOwnPr } =
    useReviewPageContext();
  const active = runningUrl === item.htmlUrl;
  const itemMerging = mergingUrl === item.htmlUrl;
  const disabled = busy && !active && !itemMerging;

  return (
    <div
      className={`pr-item${active || itemMerging ? " is-active" : ""}${disabled ? " is-disabled" : ""}`}
    >
      <div className="pr-item-body">
        <div className="pr-item-top">
          <div className="pr-item-main">
            <a
              className={`pr-link${busy ? " is-disabled" : ""}`}
              href={item.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                if (busy) event.preventDefault();
              }}
            >
              <StatusPill tone="accent" mono>
                #{item.number}
              </StatusPill>
            </a>
            <a
              className={`pr-title pr-link${busy ? " is-disabled" : ""}`}
              href={item.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                if (busy) event.preventDefault();
              }}
            >
              {item.title}
            </a>
          </div>
          {active ? <StatusPill tone="info">执行中</StatusPill> : null}
          {itemMerging ? <StatusPill tone="info">Merge 中</StatusPill> : null}
        </div>
        <div className="pr-item-meta">
          <StatusPillGroup>
            <StatusPill>
              {REVIEW_AUTHOR_LABELS[item.author as ReviewAuthor] ?? item.author}
            </StatusPill>
            {item.approved ? (
              <StatusPill tone="success">已 Approve</StatusPill>
            ) : null}
          </StatusPillGroup>
          <span className="pr-updated">updated {formatUpdatedAt(item.updatedAt)}</span>
          <span className="pr-branches">
            <code>{item.head}</code>
            <span aria-hidden> → </span>
            <code className={item.base === "main" ? "is-main" : undefined}>
              {item.base}
            </code>
          </span>
        </div>
      </div>
      <div className="pr-item-actions">
        {isOwnReviewAuthor(item.author) ? (
          <>
            <Button
              className="pr-ship-btn"
              icon={<CopyOutlined />}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                if (busy) return;
                void copyOwnPr(item.htmlUrl, item.title);
              }}
            >
              复制
            </Button>
            <Button
              type="primary"
              className="pr-ship-btn"
              icon={<MergeCellsOutlined />}
              loading={itemMerging}
              disabled={busy && !itemMerging}
              onClick={(event) => {
                event.stopPropagation();
                if (busy) return;
                void runMerge(item.htmlUrl);
              }}
            >
              Merge
            </Button>
          </>
        ) : (
          <Button
            type="primary"
            className="pr-ship-btn"
            icon={<RocketOutlined />}
            loading={active}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              if (busy) return;
              void runShip(item.htmlUrl);
            }}
          >
            Ship
          </Button>
        )}
      </div>
    </div>
  );
}
