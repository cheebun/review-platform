import type { cn } from "tailwind-variants";
import { tv, type VariantProps } from "tailwind-variants";
import type { TwcComponentProps } from "react-twc";
import { twx } from "./twx";

const textVariants = tv({
  base: "",
  variants: {
    tone: {
      default: "text-on-surface",
      muted: "text-secondary-text",
      success: "text-on-success-soft",
      warning: "text-on-warning-soft",
      danger: "text-on-danger-soft",
    },
    weight: { normal: "font-normal", medium: "font-medium", semibold: "font-semibold" },
  },
  defaultVariants: { tone: "default", weight: "normal" },
});

type TextVariants = VariantProps<typeof textVariants>;

export const Text = twx("span").transientProps(["tone", "weight"])<
  TwcComponentProps<"span", typeof cn> & TextVariants
>((props) => textVariants({ tone: props.tone, weight: props.weight }));

const headingVariants = tv({
  base: "font-semibold text-heading",
  variants: {
    level: {
      1: "text-3xl",
      2: "text-2xl",
      3: "text-xl",
      4: "text-lg",
      5: "text-base",
      6: "text-sm",
    },
  },
});

const headingClass = (level: 1 | 2 | 3 | 4 | 5 | 6) => headingVariants({ level });

const H1 = twx("h1")(() => headingClass(1));
const H2 = twx("h2")(() => headingClass(2));
const H3 = twx("h3")(() => headingClass(3));
const H4 = twx("h4")(() => headingClass(4));
const H5 = twx("h5")(() => headingClass(5));
const H6 = twx("h6")(() => headingClass(6));
const headings = { 1: H1, 2: H2, 3: H3, 4: H4, 5: H5, 6: H6 } as const;

type HeadingProps = TwcComponentProps<"h2", typeof cn> & { level?: keyof typeof headings };

export function Heading({ level = 2, ...rest }: HeadingProps) {
  const Tag = headings[level];
  return <Tag {...rest} />;
}

export const Code = twx("code")(() => "font-mono text-code-inline text-heading");

type TextLinkProps = TwcComponentProps<"a", typeof cn> & { external?: boolean };

export const TextLink = twx("a")
  .transientProps(["external"])
  .attrs<TextLinkProps>((props) =>
    props.external ? { target: "_blank", rel: "noopener noreferrer" } : {},
  )<TextLinkProps>(
  () =>
    "text-primary-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
);
