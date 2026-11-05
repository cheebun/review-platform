import type { ReactNode } from "react";

export type StatusPillTone =
  | "neutral"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

export type StatusPillProps = {
  tone?: StatusPillTone;
  mono?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
};

export function StatusPill({
  tone = "neutral",
  mono = false,
  children,
  className,
  title,
}: StatusPillProps) {
  const classes = [
    "status-pill",
    `status-pill--${tone}`,
    mono ? "status-pill--mono" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}

export function StatusPillGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={["status-pill-group", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}
