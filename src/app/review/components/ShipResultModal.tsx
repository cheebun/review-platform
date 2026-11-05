"use client";

import { StatusPill, StatusPillGroup } from "@/components/StatusPill";
import { REVIEW_AUTHOR_LABELS, type ReviewAuthor } from "@/lib/repos";
import { Button, Modal, Typography } from "antd";
import { resultModalTitle } from "../lib/review-ui";
import { FindingsBySeverity } from "./FindingsBySeverity";
import { useReviewPageContext } from "./ReviewPageProvider";

export function ShipResultModal() {
  const {
    resultOpen,
    result,
    forcing,
    canForceMerge,
    forceActionLabel,
    setState,
    runForceApproveMerge,
  } = useReviewPageContext();
  const onClose = () => setState({ status: "idle" });

  return (
    <Modal
      open={resultOpen}
      title={result ? resultModalTitle(result) : "Ship 结果"}
      onCancel={() => {
        if (forcing) return;
        onClose();
      }}
      footer={
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <Button
            size="large"
            style={{ minWidth: 120, height: 44 }}
            disabled={forcing}
            onClick={onClose}
          >
            关闭
          </Button>
          {canForceMerge ? (
            <Button
              type="primary"
              size="large"
              style={{ minWidth: 200, height: 44 }}
              loading={forcing}
              onClick={() => void runForceApproveMerge()}
            >
              {forceActionLabel}
            </Button>
          ) : null}
        </div>
      }
      width={720}
      destroyOnHidden
      maskClosable={!forcing}
      styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
    >
      {result ? (
        <div style={{ display: "grid", gap: 18 }}>
          <div className="result-meta">
            <Typography.Link href={result.pr.htmlUrl} target="_blank" strong>
              {result.pr.owner}/{result.pr.repo}#{result.pr.number}
            </Typography.Link>
            <Typography.Text>{result.pr.title}</Typography.Text>
            <StatusPillGroup>
              <StatusPill>
                {REVIEW_AUTHOR_LABELS[result.pr.author as ReviewAuthor] ??
                  result.pr.author}
              </StatusPill>
              <StatusPill tone="muted">
                {result.pr.head} → {result.pr.base}
              </StatusPill>
              {result.merged ? (
                <StatusPill tone="success">已合并</StatusPill>
              ) : null}
              {!result.approved ? (
                <StatusPill tone="danger">已要求修改</StatusPill>
              ) : null}
            </StatusPillGroup>
          </div>

          <section style={{ display: "grid", gap: 6 }}>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              摘要
            </Typography.Text>
            <Typography.Paragraph style={{ marginBottom: 0, color: "var(--ink)" }}>
              {result.review.summaryZh || result.review.summary}
            </Typography.Paragraph>
          </section>

          <section style={{ display: "grid", gap: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              问题
            </Typography.Text>
            <FindingsBySeverity findings={result.review.findings} />
          </section>

          {(result.review.verificationRequestsZh ??
            result.review.verificationRequests
          ).length > 0 ? (
            <section style={{ display: "grid", gap: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                验证请求
              </Typography.Text>
              <ol style={{ margin: 0, paddingLeft: 20, color: "var(--ink)" }}>
                {(
                  result.review.verificationRequestsZh ??
                  result.review.verificationRequests
                ).map((item, index) => (
                  <li key={`${index}-${item.slice(0, 24)}`} style={{ marginBottom: 6 }}>
                    {item}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
