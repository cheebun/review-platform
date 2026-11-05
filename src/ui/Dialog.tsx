import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import X from "~icons/lucide/x";
import { twx } from "./twx";

const Backdrop = twx(BaseDialog.Backdrop)(
  () =>
    "fixed inset-0 bg-black/40 dark:bg-black/60 motion-safe:transition-opacity motion-safe:duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
);
const Viewport = twx(BaseDialog.Viewport)(
  () => "fixed inset-0 flex items-center justify-center overflow-y-auto p-4",
);
const Popup = twx(BaseDialog.Popup)(
  () =>
    "relative flex w-full max-w-lg flex-col gap-4 rounded-lg border border-border bg-surface p-6 text-on-surface outline-none motion-safe:transition motion-safe:duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
);
const Title = twx(BaseDialog.Title)(() => "pr-8 text-headline-sm text-heading");
const Description = twx(BaseDialog.Description)(() => "text-sm text-secondary-text");
const Body = twx("div")(() => "text-sm");
const Footer = twx("div")(() => "flex flex-wrap justify-end gap-2");
// Base UI's Close already renders type="button" via useButton, so no .attrs here.
const CloseButton = twx(BaseDialog.Close)(
  () =>
    "absolute right-3 top-3 inline-flex size-control-sm items-center justify-center rounded-sm text-secondary-text outline-none hover:bg-hover-fill focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);

const CloseIcon = twx(X)(() => "size-4");

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** When false (e.g. while busy) Escape, outside click and the close button are disabled. */
  dismissible?: boolean;
  /** Accessible name of the close button. Caller supplies the language. */
  closeLabel?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  dismissible = true,
  closeLabel = "Close",
}: DialogProps) {
  return (
    <BaseDialog.Root
      open={open}
      disablePointerDismissal={!dismissible}
      onOpenChange={(next, details) => {
        if (!next && !dismissible) {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
    >
      <BaseDialog.Portal>
        <Backdrop />
        <Viewport>
          <Popup>
            <Title>{title}</Title>
            {description ? <Description>{description}</Description> : null}
            {children ? <Body>{children}</Body> : null}
            {footer ? <Footer>{footer}</Footer> : null}
            {dismissible ? (
              <CloseButton aria-label={closeLabel}>
                <CloseIcon aria-hidden />
              </CloseButton>
            ) : null}
          </Popup>
        </Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
