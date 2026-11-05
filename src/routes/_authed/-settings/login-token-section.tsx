import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useId, useRef, type FormEvent } from "react";
import { rotateLoginToken } from "../../../functions/login-token";
import type { LoginTokenFnResult } from "../../../functions/login-token.logic";
import { Button, Form, FormError, twx } from "../../../ui";
import { firstError, serverError, setServerErrors, TextField } from "../../-form-field";
import {
  confirmError,
  lockedOutText,
  newTokenError,
  newTokenServerErrors,
  TOKEN_RULES_TEXT,
} from "../../-login-token-text";

/** The rotation server function. Injectable for tests. */
export interface RotateClient {
  rotate(input: { current: string; token: string; confirm: string }): Promise<LoginTokenFnResult>;
}

const Section = twx("section")(() => "flex flex-col gap-4");
const SectionTitle = twx("h2")(() => "text-headline-md text-heading");
const Description = twx("p")(() => "max-w-3xl text-body-sm text-secondary-text");
const Fields = twx("div")(() => "flex flex-col gap-3 sm:max-w-md");
const Actions = twx("div")(() => "flex");

const EMPTY_CURRENT = "请输入当前登录令牌";
const WRONG_CURRENT = "当前登录令牌错误";
const GENERIC_ERROR = "更换失败，请稍后重试。";

const defaultClient: RotateClient = {
  rotate: (data) => rotateLoginToken({ data }),
};
/** A full reload of /login: the session is gone and every cached query with it. */
const defaultAfterRotate = () => window.location.assign("/login");

interface Props {
  client?: RotateClient;
  /** Runs after a successful rotation, which has signed every session out (FR-AUTH-07). */
  afterRotate?: () => void;
}

type Values = { current: string; token: string; confirm: string };
const FIELDS = [
  ["current", "当前登录令牌", "current-password"],
  ["token", "新登录令牌", "new-password"],
  ["confirm", "再次输入新登录令牌", "new-password"],
] as const;

/** Server field errors as form field errors, or undefined for a form-level message. */
function serverFields(result: Extract<LoginTokenFnResult, { ok: false }>, value: Values) {
  const { error } = result;
  if (error.kind === "validation" && error.field === "current") return { current: WRONG_CURRENT };
  return newTokenServerErrors(error, value.token);
}

/** /settings, login token (FR-AUTH-07): replace the token; every session signs out. */
export function LoginTokenSection({
  client = defaultClient,
  afterRotate = defaultAfterRotate,
}: Props) {
  const uid = useId();
  // Synchronous guard: two submit events in one tick both see `isSubmitting` false.
  const pending = useRef(false);
  const form = useForm({
    defaultValues: { current: "", token: "", confirm: "" } as Values,
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        const fields = {
          current: value.current === "" ? EMPTY_CURRENT : undefined,
          token: newTokenError(value.token),
          confirm: confirmError(value.token, value.confirm),
        };
        return fields.current || fields.token || fields.confirm ? { fields } : undefined;
      },
    },
    onSubmit: async ({ value, formApi }) => {
      let failure = GENERIC_ERROR;
      try {
        // Verbatim: a token is never trimmed.
        const result = await client.rotate(value);
        if (result.ok) return afterRotate();
        const fields = serverFields(result, value);
        if (fields) return setServerErrors(formApi, { fields });
        if (result.error.kind === "rate_limited") {
          failure = lockedOutText(result.error.retryAfterSeconds);
        }
      } catch {
        // The generic message.
      }
      setServerErrors(formApi, { form: failure });
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (pending.current) return;
    pending.current = true;
    void form.handleSubmit().finally(() => {
      pending.current = false;
    });
  };

  return (
    <Section aria-labelledby="settings-login-token">
      <SectionTitle id="settings-login-token">登录令牌</SectionTitle>
      <Description>
        更换后所有会话都会退出，包括当前会话，需要用新令牌重新登录。新令牌{TOKEN_RULES_TEXT}
      </Description>
      <Form method="post" onSubmit={submit} noValidate aria-label="更换登录令牌">
        <Fields>
          {FIELDS.map(([name, label, autoComplete]) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <TextField
                  label={label}
                  id={`${uid}-${name}`}
                  message={firstError(field.state.meta.errors)}
                  name={field.name}
                  type="password"
                  autoComplete={autoComplete}
                  required
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              )}
            </form.Field>
          ))}
        </Fields>
        <Actions>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" loading={isSubmitting}>
                更换登录令牌
              </Button>
            )}
          </form.Subscribe>
        </Actions>
        <form.Subscribe selector={(state) => serverError(state.errorMap.onServer)}>
          {(failure) => (failure ? <FormError>{failure}</FormError> : null)}
        </form.Subscribe>
      </Form>
    </Section>
  );
}
