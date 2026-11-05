import type { cn } from "tailwind-variants";
import { tv, type VariantProps } from "tailwind-variants";
import type { TwcComponentProps } from "react-twc";
import { Spinner } from "./Spinner";
import { twx } from "./twx";

export const buttonVariants = tv({
  base: "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
  variants: {
    variant: {
      primary: "bg-primary text-on-primary hover:bg-primary/90",
      secondary:
        "border border-border bg-background text-heading hover:border-border-strong hover:bg-hover-fill",
      ghost: "border border-transparent bg-transparent text-heading hover:bg-hover-fill",
      danger: "bg-danger text-on-danger hover:bg-danger/90",
    },
    size: {
      sm: "h-control-sm px-3 text-sm",
      md: "h-control-md px-4 text-sm",
      lg: "h-control-lg px-5 text-base",
    },
    iconOnly: { true: "px-0", false: "" },
  },
  compoundVariants: [
    { iconOnly: true, size: "sm", class: "w-control-sm" },
    { iconOnly: true, size: "md", class: "w-control-md" },
    { iconOnly: true, size: "lg", class: "w-control-lg" },
  ],
  defaultVariants: { variant: "primary", size: "md", iconOnly: false },
});

type ButtonVariants = VariantProps<typeof buttonVariants>;
type StyledButtonProps = TwcComponentProps<"button", typeof cn> & ButtonVariants;

const StyledButton = twx("button")
  .transientProps(["variant", "size", "iconOnly"])
  .attrs({ type: "button" })<StyledButtonProps>((props) =>
  buttonVariants({ variant: props.variant, size: props.size, iconOnly: props.iconOnly }),
);

type ButtonBaseProps = Omit<StyledButtonProps, "iconOnly" | "asChild"> & {
  /** Swaps in a Spinner, sets aria-busy and disables the button. */
  loading?: boolean;
};

export type ButtonProps = ButtonBaseProps &
  ({ iconOnly: true; "aria-label": string } | { iconOnly?: false });

export function Button({ loading = false, disabled, children, ...rest }: ButtonProps) {
  return (
    <StyledButton {...rest} disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? <Spinner /> : null}
      {loading && rest.iconOnly ? null : children}
    </StyledButton>
  );
}
