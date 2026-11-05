import { createLink } from "@tanstack/react-router";
import { useId, type ReactNode } from "react";
import { Alert, Button, RefreshIcon, Skeleton, twx } from "../../../ui";
import { workbenchErrorText } from "./workbench-errors";

const Root = twx("section")(
  () =>
    "flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface px-card-padding-x py-5",
);
const Head = twx("div")(() => "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1");
const Title = twx("h2")(() => "text-headline-sm text-heading");
const Refresh = twx(RefreshIcon).attrs({ "aria-hidden": true })(() => "size-4");

const Anchor = twx("a")(
  () =>
    "text-label-md text-primary-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
);
/** A router-aware text link, for links inside the cards. */
export const CardLink = createLink(Anchor);

/** One overview card: a titled region, so each card can be found and read on its own. */
export function Card({
  title,
  link,
  className,
  children,
}: {
  title: string;
  /** The "see all" link in the header. */
  link?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Root aria-labelledby={id} className={className}>
      <Head>
        <Title id={id}>{title}</Title>
        {link}
      </Head>
      {children}
    </Root>
  );
}

/** The loading state of a card. */
export function CardLoading({ label, lines = 3 }: { label: string; lines?: number }) {
  return <Skeleton lines={lines} aria-label={label} />;
}

/** The error state of a card: fixed text with the request id, and a retry. */
export function CardError({
  error,
  action,
  onRetry,
}: {
  error: unknown;
  action: string;
  onRetry: () => void;
}) {
  return (
    <Alert
      tone="danger"
      title={workbenchErrorText(error, action)}
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <Refresh />
          重试
        </Button>
      }
    />
  );
}
