import { Toaster as Sonner, toast, type ToasterProps } from "sonner";
import { tv } from "tailwind-variants";

const toastStyles = tv({
  slots: {
    toast:
      "flex w-full items-start gap-3 rounded-md border border-border bg-surface px-4 py-3 text-body-sm text-heading",
    title: "text-label-md text-heading",
    description: "text-secondary-text",
  },
});

const styles = toastStyles();

/** Token-themed sonner host. Mount once near the app root. */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      position="top-center"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: styles.toast(),
          title: styles.title(),
          description: styles.description(),
          success: "border-success-border bg-success-soft text-on-success-soft",
          error: "border-danger-border bg-danger-soft text-on-danger-soft",
          warning: "border-warning-border bg-warning-soft text-on-warning-soft",
        },
      }}
      {...props}
    />
  );
}

/** Callers pass already-translated text. */
export const notify = {
  success: (message: string) => toast.success(message),
  error: (message: string) => toast.error(message),
  warning: (message: string) => toast.warning(message),
};
