"use client";

import {
  DEFAULT_OPEN_PR_OWNER,
  DEFAULT_OPEN_PR_REPO,
  isOwnReviewAuthor,
} from "@/lib/repos";
import { ArrowRightOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Skeleton, Spin, Typography } from "antd";
import Link from "next/link";
import { AuthorFilter } from "./AuthorFilter";
import { PrListItem } from "./PrListItem";
import { useReviewPageContext } from "./ReviewPageProvider";

export function OpenPrSection({ ownOnly = false }: { ownOnly?: boolean }) {
  const {
    listState,
    refreshing,
    busy,
    visibleItems,
    loadOpenPulls,
  } = useReviewPageContext();
  const items =
    listState.status === "ready" && ownOnly
      ? listState.items.filter((item) => isOwnReviewAuthor(item.author))
      : visibleItems;

  return (
    <section
      className={ownOnly ? "slack-review-status" : undefined}
      style={{ display: "grid", gap: 12 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {ownOnly ? (
          <Link href="/review" className="workbench-module-title">
            我的 PR <ArrowRightOutlined />
          </Link>
        ) : (
          <Typography.Title level={5} style={{ margin: 0 }}>
            Open PRs · {DEFAULT_OPEN_PR_OWNER}/{DEFAULT_OPEN_PR_REPO}
          </Typography.Title>
        )}
        <Button
          icon={<ReloadOutlined />}
          onClick={() => void loadOpenPulls()}
          loading={refreshing || listState.status === "idle"}
          disabled={busy}
        >
          刷新
        </Button>
      </div>

      {!ownOnly ? <AuthorFilter /> : null}

      {listState.status === "error" && (
        <Alert type="error" showIcon message={listState.message} />
      )}

      {listState.status === "idle" && (
        <Skeleton active paragraph={{ rows: 4 }} title={false} />
      )}

      {listState.status === "ready" && (
        <Spin spinning={refreshing} tip="刷新中…">
          {items.length === 0 ? (
            <Typography.Text type="secondary">
              {ownOnly
                ? "当前没有 open PR。"
                : listState.items.length === 0
                ? "白名单作者当前没有非 draft 的 open PR。"
                : "当前筛选条件下没有 open PR。"}
            </Typography.Text>
          ) : (
            <div className="pr-list">
              {items.map((item) => (
                <PrListItem key={item.number} item={item} />
              ))}
            </div>
          )}
        </Spin>
      )}
    </section>
  );
}
