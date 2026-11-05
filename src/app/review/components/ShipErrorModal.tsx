"use client";

import { Button, Modal, Typography } from "antd";
import { useReviewPageContext } from "./ReviewPageProvider";

export function ShipErrorModal() {
  const { errorOpen, errorMessage, setState } = useReviewPageContext();
  const onClose = () => setState({ status: "idle" });

  return (
    <Modal
      open={errorOpen}
      title="Ship 执行失败"
      onCancel={onClose}
      footer={
        <Button
          type="primary"
          size="large"
          style={{ minWidth: 120, height: 44 }}
          onClick={onClose}
        >
          关闭
        </Button>
      }
      width={560}
      destroyOnHidden
    >
      <Typography.Paragraph
        style={{
          marginBottom: 0,
          whiteSpace: "pre-wrap",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 10,
          padding: 14,
          color: "#991b1b",
        }}
      >
        {errorMessage}
      </Typography.Paragraph>
    </Modal>
  );
}
