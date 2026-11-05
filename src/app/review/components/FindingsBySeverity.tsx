import { StatusPill } from "@/components/StatusPill";
import type { Finding } from "@/lib/types";
import { Space, Typography } from "antd";
import { SEV_LABEL, SEV_ORDER, severityTone } from "../lib/review-ui";

export function FindingsBySeverity({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return <Typography.Text type="secondary">暂无问题。</Typography.Text>;
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {SEV_ORDER.map((severity) => {
        const items = findings.filter((f) => f.severity === severity);
        if (items.length === 0) return null;
        return (
          <div key={severity} style={{ display: "grid", gap: 8 }}>
            <Typography.Text strong style={{ color: "var(--ink)" }}>
              {SEV_LABEL[severity]} · {items.length}
            </Typography.Text>
            <div style={{ display: "grid", gap: 8 }}>
              {items.map((finding, index) => (
                <div
                  key={`${severity}-${index}`}
                  className={`finding-item sev-${finding.severity}`}
                >
                  <Space wrap size={[8, 8]} style={{ marginBottom: 6 }}>
                    <StatusPill tone={severityTone(finding.severity)}>
                      {SEV_LABEL[finding.severity]}
                    </StatusPill>
                    <Typography.Text strong>
                      {finding.titleZh || finding.title}
                    </Typography.Text>
                    {finding.path ? (
                      <Typography.Text type="secondary" code>
                        {finding.path}
                        {finding.line != null ? `:${finding.line}` : ""}
                      </Typography.Text>
                    ) : null}
                  </Space>
                  <Typography.Paragraph
                    style={{
                      marginBottom: 0,
                      color: "var(--ink)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {finding.bodyZh || finding.body}
                  </Typography.Paragraph>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
