import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import type { ReactNode } from "react";
import ChevronDown from "~icons/lucide/chevron-down";
import { twx } from "./twx";

const Trigger = twx(BaseCollapsible.Trigger)(
  () =>
    "group flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-heading outline-none hover:bg-hover-fill focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);
const Chevron = twx(ChevronDown)(
  () =>
    "size-4 text-secondary-text motion-safe:transition-transform group-data-[panel-open]:rotate-180",
);
const Panel = twx(BaseCollapsible.Panel)(() => "px-3 py-2 text-sm text-on-surface");
const Root = twx(BaseCollapsible.Root)(() => "rounded-lg border border-border bg-surface");

interface CollapsibleProps {
  title: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

export function Collapsible({
  title,
  open,
  defaultOpen,
  onOpenChange,
  children,
}: CollapsibleProps) {
  return (
    <Root open={open} defaultOpen={defaultOpen} onOpenChange={(next) => onOpenChange?.(next)}>
      <Trigger>
        {title}
        <Chevron aria-hidden />
      </Trigger>
      <Panel>{children}</Panel>
    </Root>
  );
}
