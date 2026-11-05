import type { StatusPillTone } from "@/components/StatusPill";
import type { ExecuteResult, OpenPrItem, Severity } from "@/lib/types";

export const SEV_LABEL: Record<Severity, string> = {
  P0: "P0 阻塞",
  P1: "P1 高优",
  P2: "P2 中等",
  Nit: "Nit 微调",
};

export const SEV_ORDER: Severity[] = ["P0", "P1", "P2", "Nit"];

export function severityTone(severity: Severity): StatusPillTone {
  switch (severity) {
    case "P0":
      return "danger";
    case "P1":
      return "warning";
    case "P2":
      return "neutral";
    case "Nit":
      return "info";
  }
}

export type UiState =
  | { status: "idle" }
  | { status: "running"; url: string }
  | { status: "result"; result: ExecuteResult }
  | { status: "error"; message: string };

export type ListState =
  | { status: "idle" }
  | { status: "ready"; items: OpenPrItem[] }
  | { status: "error"; message: string };

export function formatUpdatedAt(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function successToastMessage(result: ExecuteResult): string {
  if (result.merged) return "已完成：Approve + Merge";
  return "已完成：Approve（未 Merge）";
}

export function resultModalTitle(result: ExecuteResult): string {
  if (!result.approved) return "未通过：存在 P0";
  if (result.merged) return "已完成 Approve + Merge（仍有问题）";
  return "已完成 Approve（仍有问题）";
}

export function isCleanSuccess(result: ExecuteResult): boolean {
  return result.approved && result.review.findings.length === 0;
}
