import type { ReactNode } from "react";
import Inbox from "~icons/lucide/inbox";
import { twx } from "./twx";

const Root = twx("div")(
  () => "flex flex-col items-center gap-3 py-8 text-center text-secondary-text",
);
const Description = twx("p")(() => "text-sm");
const EmptyIcon = twx(Inbox)(() => "size-8 text-muted-text");

interface EmptyProps {
  description?: ReactNode;
  children?: ReactNode;
}

export function Empty({ description, children }: EmptyProps) {
  return (
    <Root>
      <EmptyIcon aria-hidden />
      {description ? <Description>{description}</Description> : null}
      {children}
    </Root>
  );
}
