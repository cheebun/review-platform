import LoadingLoop from "~icons/line-md/loading-loop";
import LoaderCircle from "~icons/lucide/loader-circle";
import { twx } from "./twx";

const SpinnerAnimated = twx(LoadingLoop).attrs({ "aria-hidden": true })(
  () => "size-4 motion-reduce:hidden",
);
const SpinnerStatic = twx(LoaderCircle).attrs({ "aria-hidden": true })(
  () => "size-4 motion-safe:hidden",
);

export function Spinner() {
  return (
    <>
      <SpinnerAnimated />
      <SpinnerStatic />
    </>
  );
}
