import type { ReactNode } from "react";
import { Spinner } from "./Spinner";
import { twx } from "./twx";

const Root = twx("div")(() => "relative");
const Scrim = twx("div").attrs({ role: "status" })(
  () =>
    "absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface/70 text-sm text-secondary-text",
);

interface LoadingOverlayProps {
  loading: boolean;
  /** Text shown under the spinner. Caller supplies the language. */
  tip?: ReactNode;
  children: ReactNode;
}

export function LoadingOverlay({ loading, tip, children }: LoadingOverlayProps) {
  return (
    <Root aria-busy={loading || undefined}>
      {children}
      {loading ? (
        <Scrim>
          <Spinner />
          {tip ? <span>{tip}</span> : null}
        </Scrim>
      ) : null}
    </Root>
  );
}
