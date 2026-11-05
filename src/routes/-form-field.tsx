import type { ComponentProps } from "react";
import { Input, Label, twx } from "../ui";

/*
 * Field helpers shared by the TanStack Form forms (login and the /settings sections).
 */

const FieldError = twx("p")(() => "text-sm text-on-danger-soft");

/** The first error of a field as text. Validators here only ever return strings. */
export function firstError(errors: readonly unknown[]): string | undefined {
  const first = errors.find((e) => typeof e === "string" && e !== "");
  return typeof first === "string" ? first : undefined;
}

/**
 * Puts a server answer into the form's `onServer` error slot: `form` shows as the alert, `fields`
 * on their inputs. Field errors in this slot clear when that field changes; the whole slot clears
 * on the next submit.
 *
 * TanStack Form types `onServer` from a react-form-start server validator. These forms fill it
 * from a server function's result instead, so the slot is typed here, once.
 */
export function setServerErrors(
  formApi: { setErrorMap(errorMap: never): void },
  errors: { form?: string; fields?: Record<string, string | undefined> },
): void {
  formApi.setErrorMap({ onServer: { form: errors.form, fields: errors.fields ?? {} } } as never);
}

/** The form-level server error as text, if any. */
export function serverError(onServer: unknown): string | undefined {
  return typeof onServer === "string" && onServer !== "" ? onServer : undefined;
}

/** Props that tie an input to its error paragraph, or nothing while the field is valid. */
function invalidProps(id: string, message: string | undefined) {
  return message ? ({ "aria-invalid": true, "aria-describedby": id } as const) : ({} as const);
}

type TextFieldProps = ComponentProps<typeof Input> & {
  label: string;
  /** Id of the error paragraph, referenced by the input's aria-describedby. */
  id: string;
  message: string | undefined;
};

/** A labelled input with its field error underneath. */
export function TextField({ label, id, message, ...input }: TextFieldProps) {
  return (
    <>
      <Label>
        {label}
        <Input {...input} {...invalidProps(id, message)} />
      </Label>
      {message ? <FieldError id={id}>{message}</FieldError> : null}
    </>
  );
}
