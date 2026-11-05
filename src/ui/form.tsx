import { Button } from "./Button";
import { twx } from "./twx";

export const Form = twx("form")(() => "flex flex-col gap-3");
export const Label = twx("label")(() => "flex flex-col gap-1 text-sm text-secondary-text");
export const Input = twx("input")(
  () =>
    "h-control-md rounded-md border border-border bg-surface px-3 text-body-sm text-heading outline-none placeholder:text-muted-text hover:border-border-strong focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);
export const SubmitButton = twx(Button).attrs({ type: "submit" })(() => "w-full");
export const FormError = twx("p").attrs({ role: "alert" })(() => "text-sm text-on-danger-soft");
