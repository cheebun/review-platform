import type { ReactNode } from "react";
import type { cn } from "tailwind-variants";
import { tv, type VariantProps } from "tailwind-variants";
import type { TwcComponentProps } from "react-twc";
import X from "~icons/lucide/x";
import { twx } from "./twx";

const tagVariants = tv({
  base: "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-label-sm",
  variants: {
    tone: {
      neutral: "border-transparent bg-primary-soft text-primary-ink",
      info: "border-info-border bg-info-soft text-on-info-soft",
      success: "border-success-border bg-success-soft text-on-success-soft",
      warning: "border-warning-border bg-warning-soft text-on-warning-soft",
      danger: "border-danger-border bg-danger-soft text-on-danger-soft",
    },
  },
  defaultVariants: { tone: "neutral" },
});

type TagVariants = VariantProps<typeof tagVariants>;
type TagRootProps = TwcComponentProps<"span", typeof cn> & TagVariants;

const TagRoot = twx("span").transientProps(["tone"])<TagRootProps>((props) =>
  tagVariants({ tone: props.tone }),
);
const CloseIcon = twx(X)(() => "size-3");
const CloseButton = twx("button").attrs({ type: "button" })(
  () =>
    "inline-flex size-4 items-center justify-center rounded-full outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-primary",
);

type TagProps = TagRootProps & {
  closable?: boolean;
  onClose?: () => void;
  /** Accessible name of the close button. Caller supplies the language. */
  closeLabel?: string;
  children?: ReactNode;
};

export function Tag({
  closable = false,
  onClose,
  closeLabel = "Remove",
  children,
  ...rest
}: TagProps) {
  return (
    <TagRoot {...rest}>
      {children}
      {closable ? (
        <CloseButton aria-label={closeLabel} onClick={onClose}>
          <CloseIcon aria-hidden />
        </CloseButton>
      ) : null}
    </TagRoot>
  );
}
