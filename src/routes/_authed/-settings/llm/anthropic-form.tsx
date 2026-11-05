import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useId, type FormEvent } from "react";
import type { LlmSettingsView } from "../../../../application/settings/llm-settings";
import {
  parseLlmBaseUrl,
  parseLlmModel,
  parseLlmSecret,
} from "../../../../domain/settings/llm-settings";
import {
  saveAnthropicSettingsFn,
  testAnthropicSettingsFn,
} from "../../../../functions/settings-llm";
import { Button, Form, FormError, Select, notify, twx } from "../../../../ui";
import { firstError, serverError, setServerErrors, TextField } from "../../../-form-field";
import {
  CREDENTIAL_REJECTED_TEXT,
  ENDPOINT_REFUSED_TEXT,
  LLM_FIELD_TEXT,
  LlmFnError,
  llmErrorText,
} from "./llm-errors";
import { callLlmFn, llmSettingsKeys } from "./llm-queries";

const Grid = twx("div")(() => "grid gap-3 sm:grid-cols-2");
const Hint = twx("p")(() => "text-body-sm text-secondary-text");
const FieldBox = twx("div")(() => "flex flex-col gap-1");
const FieldLabel = twx("span")(() => "text-sm text-secondary-text");

type Values = {
  credentialType: "api_key" | "auth_token";
  secret: string;
  baseUrl: string;
  model: string;
};

const CREDENTIAL_ITEMS = [
  { value: "api_key", label: "API key" },
  { value: "auth_token", label: "Auth token" },
] as const;
type Section = LlmSettingsView["anthropic"];

const defaults = (s: Section): Values => ({
  credentialType: s.credentialType ?? "api_key",
  secret: "",
  baseUrl: s.baseUrl ?? "",
  model: s.model ?? "",
});

/** A ready credential of this type is stored, so the input may stay empty. */
const keepsStored = (s: Section, type: Values["credentialType"]) =>
  s.credential.state === "set" && s.credentialType === type;

function clientErrors(s: Section, v: Values): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  if (!parseLlmBaseUrl(v.baseUrl, "baseUrl").ok) fields["baseUrl"] = LLM_FIELD_TEXT.baseUrl;
  if (!parseLlmModel(v.model, "model").ok) fields["model"] = LLM_FIELD_TEXT.model;
  if (v.secret.trim() === "") {
    if (!keepsStored(s, v.credentialType)) fields["secret"] = LLM_FIELD_TEXT.credential;
  } else if (!parseLlmSecret(v.secret, "apiKey").ok) {
    fields["secret"] = LLM_FIELD_TEXT.secret;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** The server's answer on a field, in fixed client text. */
function serverFieldErrors(error: LlmFnError): Record<string, string> | undefined {
  const { kind, field } = error.body;
  if (field === "apiKey" || field === "authToken") {
    return { secret: kind === "forbidden" ? CREDENTIAL_REJECTED_TEXT : LLM_FIELD_TEXT.secret };
  }
  if (field === "credential") return { secret: LLM_FIELD_TEXT.credential };
  // The client checked the format, so a base URL error is the endpoint refusing the probe.
  if (field === "baseUrl") return { baseUrl: ENDPOINT_REFUSED_TEXT };
  if (field === "model") return { model: LLM_FIELD_TEXT.model };
  return undefined;
}

/** Independent save and connection test actions share boundary validation. */
export function AnthropicForm({ section }: { section: Section }) {
  const uid = useId();
  const queryClient = useQueryClient();
  const form = useForm({
    defaultValues: defaults(section),
    onSubmitMeta: { action: "save" as "save" | "test" },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        const fields = clientErrors(section, value);
        return fields ? { fields } : undefined;
      },
    },
    onSubmit: async ({ value, formApi, meta }) => {
      const secret = value.secret.trim();
      const data = {
        baseUrl: value.baseUrl,
        model: value.model,
        ...(secret === ""
          ? {}
          : value.credentialType === "auth_token"
            ? { authToken: secret }
            : { apiKey: secret }),
      };
      try {
        if (meta.action === "test") {
          const probe = await callLlmFn(testAnthropicSettingsFn({ data }));
          // Only a test of the saved settings returns a view (now verified); a draft keeps its inputs.
          if (probe.view) queryClient.setQueryData(llmSettingsKeys.view(), probe.view);
          notify.success(`连接测试成功（${probe.model}，${probe.latencyMs} ms）`);
        } else {
          const saved = await callLlmFn(saveAnthropicSettingsFn({ data }));
          formApi.setFieldValue("secret", "");
          queryClient.setQueryData(llmSettingsKeys.view(), saved.view);
          notify.success("Anthropic 设置已保存");
        }
      } catch (error) {
        if (meta.action === "test") {
          // Test failures never enter form validation state or block an independent save.
          notify.error(llmErrorText(error, "连接测试失败"));
        } else {
          const fields = error instanceof LlmFnError ? serverFieldErrors(error) : undefined;
          setServerErrors(formApi, fields ? { fields } : { form: llmErrorText(error, "保存失败") });
        }
      }
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void form.handleSubmit();
  };

  return (
    <Form onSubmit={submit} noValidate aria-label="Anthropic 表单">
      <Grid>
        <form.Field name="credentialType">
          {(field) => (
            <FieldBox>
              <FieldLabel id={`${uid}-credential-type`}>凭据类型</FieldLabel>
              <Select
                items={CREDENTIAL_ITEMS}
                value={field.state.value}
                onValueChange={(value) => {
                  if (value === "api_key" || value === "auth_token") field.handleChange(value);
                }}
                aria-labelledby={`${uid}-credential-type`}
              />
            </FieldBox>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.credentialType}>
          {(type) => (
            <form.Field name="secret">
              {(field) => (
                <TextField
                  label={type === "auth_token" ? "Auth token" : "API key"}
                  id={`${uid}-secret`}
                  message={firstError(field.state.meta.errors)}
                  name="anthropic_secret"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={keepsStored(section, type) ? "留空则保留已保存的值" : undefined}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              )}
            </form.Field>
          )}
        </form.Subscribe>
        <form.Field name="baseUrl">
          {(field) => (
            <TextField
              label="Base URL"
              id={`${uid}-base-url`}
              message={firstError(field.state.meta.errors)}
              name="anthropic_base_url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="留空使用官方端点"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
            />
          )}
        </form.Field>
        <form.Field name="model">
          {(field) => (
            <TextField
              label="模型"
              id={`${uid}-model`}
              message={firstError(field.state.meta.errors)}
              name="anthropic_model"
              autoComplete="off"
              spellCheck={false}
              placeholder={section.defaultModel}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
            />
          )}
        </form.Field>
      </Grid>
      <Hint>保存仅存储设置，不会请求 LLM 服务。测试连接会检查当前输入，不会保存设置。</Hint>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <div className="flex gap-2">
            <Button type="submit" loading={isSubmitting}>
              保存
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={isSubmitting}
              onClick={() => void form.handleSubmit({ action: "test" })}
            >
              测试连接
            </Button>
          </div>
        )}
      </form.Subscribe>
      <form.Subscribe selector={(state) => serverError(state.errorMap.onServer)}>
        {(failure) => (failure ? <FormError>{failure}</FormError> : null)}
      </form.Subscribe>
    </Form>
  );
}
