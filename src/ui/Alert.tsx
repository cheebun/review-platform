import type { ReactNode } from "react";
import type { cn } from "tailwind-variants";
import { tv, type VariantProps } from "tailwind-variants";
import type { TwcComponentProps } from "react-twc";
import CircleAlert from "~icons/lucide/circle-alert";
import CircleCheck from "~icons/lucide/circle-check";
import Info from "~icons/lucide/info";
import TriangleAlert from "~icons/lucide/triangle-alert";
import { twx } from "./twx";

const alertVariants = tv({
  base: "flex items-start gap-3 rounded-lg border px-5 py-4 text-sm",
  variants: {
    tone: {
      info: "border-info-border bg-info-soft text-on-info-soft",
      success: "border-success-border bg-success-soft text-on-success-soft",
      warning: "border-warning-border bg-warning-soft text-on-warning-soft",
      danger: "border-danger-border bg-danger-soft text-on-danger-soft",
    },
  },
  defaultVariants: { tone: "info" },
});

type AlertVariants = VariantProps<typeof alertVariants>;
type AlertRootProps = Omit<TwcComponentProps<"div", typeof cn>, "title"> & AlertVariants;

const AlertRoot = twx("div")
  .transientProps(["tone"])
  .attrs<AlertRootProps>((props) => ({
    role: props.tone === "danger" || props.tone === "warning" ? "alert" : "status",
  }))<AlertRootProps>((props) => alertVariants({ tone: props.tone }));

const Content = twx("div")(() => "flex min-w-0 flex-1 flex-col gap-0.5");
const Title = twx("p")(() => "font-medium");
const Body = twx("div")(() => "text-inherit");
const Action = twx("div")(() => "shrink-0");

const iconClass = () => "mt-0.5 size-4 shrink-0";
const defaultIcons = {
  info: twx(Info)(iconClass),
  success: twx(CircleCheck)(iconClass),
  warning: twx(TriangleAlert)(iconClass),
  danger: twx(CircleAlert)(iconClass),
} as const;

type AlertProps = AlertRootProps & {
  title?: ReactNode;
  /** Overrides the tone icon. Pass `null` to hide it. */
  icon?: ReactNode;
  action?: ReactNode;
};

export function Alert({ tone = "info", title, icon, action, children, ...rest }: AlertProps) {
  const Default = defaultIcons[tone ?? "info"];
  return (
    <AlertRoot {...rest} tone={tone}>
      {icon === undefined ? <Default aria-hidden /> : icon}
      <Content>
        {title ? <Title>{title}</Title> : null}
        {children ? <Body>{children}</Body> : null}
      </Content>
      {action ? <Action>{action}</Action> : null}
    </AlertRoot>
  );
}
