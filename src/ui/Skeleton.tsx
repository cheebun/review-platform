import type { cn } from "tailwind-variants";
import type { TwcComponentProps } from "react-twc";
import { twx } from "./twx";

const Root = twx("div").attrs({ role: "status", "aria-busy": true })(() => "flex flex-col gap-2");
const Line = twx("div").attrs({ "aria-hidden": true, "data-skeleton-line": "" })(
  () => "h-4 w-full rounded-sm bg-border motion-safe:animate-pulse last:w-3/5",
);

type SkeletonProps = TwcComponentProps<"div", typeof cn> & { lines?: number };

export function Skeleton({ lines = 3, ...rest }: SkeletonProps) {
  return (
    <Root {...rest}>
      {Array.from({ length: lines }, (_, i) => (
        <Line key={i} />
      ))}
    </Root>
  );
}
