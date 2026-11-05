import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useId, useRef, type FormEvent } from "react";
import type { LoginTokenFnResult } from "../functions/login-token.logic";
import { Alert, Form, Heading, SubmitButton, twx } from "../ui";
import { firstError, serverError, setServerErrors, TextField } from "./-form-field";

/** The login server function. Injected so the form is testable. */
export interface LoginClient {
  login(token: string): Promise<LoginTokenFnResult>;
}

const Section = twx("section")(() => "flex flex-col gap-3");

const EMPTY_TOKEN = "请输入登录令牌";
const WRONG_TOKEN = "登录令牌错误";
const GENERIC_ERROR = "登录失败，请稍后重试。";

const lockedOut = (seconds: number | undefined) =>
  `尝试次数过多，请 ${Math.max(1, Math.ceil((seconds ?? 60) / 60))} 分钟后再试。`;

interface Props {
  client: LoginClient;
  onSuccess(): void;
  /** The login token was never set: the caller goes to /setup. */
  onNotInitialized(): void;
}

/**
 * Sign-in with the login token (FR-AUTH-02). Only emptiness is checked here: the token rules are
 * not repeated at login, so a failure never hints at them. The server's message is never shown.
 */
export function LoginForm({ client, onSuccess, onNotInitialized }: Props) {
  const uid = useId();
  // Synchronous guard: two submit events in one tick both see `isSubmitting` false.
  const pending = useRef(false);
  const form = useForm({
    defaultValues: { token: "" },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) =>
        value.token === "" ? { fields: { token: EMPTY_TOKEN } } : undefined,
    },
    onSubmit: async ({ value, formApi }) => {
      let failure: string;
      try {
        // Verbatim: the token may legitimately contain spaces, and is never trimmed.
        const result = await client.login(value.token);
        if (result.ok) return onSuccess();
        if (result.error.kind === "not_found") return onNotInitialized();
        if (result.error.kind === "unauthenticated") failure = WRONG_TOKEN;
        else if (result.error.kind === "rate_limited") {
          failure = lockedOut(result.error.retryAfterSeconds);
        } else failure = GENERIC_ERROR;
      } catch {
        failure = GENERIC_ERROR;
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
    <Section>
      <Heading>登录</Heading>
      <Form method="post" onSubmit={submit} noValidate>
        <form.Field name="token">
          {(field) => (
            <TextField
              label="登录令牌"
              id={`${uid}-token`}
              message={firstError(field.state.meta.errors)}
              name={field.name}
              type="password"
              autoComplete="current-password"
              required
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
            />
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => <SubmitButton loading={isSubmitting}>登录</SubmitButton>}
        </form.Subscribe>
      </Form>
      <form.Subscribe selector={(state) => serverError(state.errorMap.onServer)}>
        {(failure) => (failure ? <Alert tone="danger">{failure}</Alert> : null)}
      </form.Subscribe>
    </Section>
  );
}
