import type { cn } from "tailwind-variants";
import { tv, type VariantProps } from "tailwind-variants";
import type { TwcComponentProps } from "react-twc";
import { twx } from "./twx";

const stackVariants = tv({
  base: "flex",
  variants: {
    direction: { col: "flex-col", row: "flex-row" },
    gap: { 0: "gap-0", 1: "gap-1", 2: "gap-2", 3: "gap-3", 4: "gap-4", 6: "gap-6", 8: "gap-8" },
    wrap: { true: "flex-wrap", false: "flex-nowrap" },
    align: {
      start: "items-start",
      center: "items-center",
      end: "items-end",
      stretch: "items-stretch",
    },
  },
  defaultVariants: { direction: "col", gap: 3, wrap: false },
});

type StackVariants = VariantProps<typeof stackVariants>;

export const Stack = twx("div").transientProps(["direction", "gap", "wrap", "align"])<
  TwcComponentProps<"div", typeof cn> & StackVariants
>((props) =>
  stackVariants({
    direction: props.direction,
    gap: props.gap,
    wrap: props.wrap,
    align: props.align,
  }),
);

/** Joins adjacent controls into one visual unit. */
export const InputGroup = twx("div").attrs({ role: "group" })(
  () =>
    "inline-flex items-stretch [&>*:not(:first-child)]:-ml-px [&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none [&>*:focus-visible]:z-10",
);
