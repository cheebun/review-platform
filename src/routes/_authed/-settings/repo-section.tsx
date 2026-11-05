import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState, type FormEvent } from "react";
import type { RepoView, SettingsView } from "../../../application/settings/view";
import {
  permissionCells,
  type PermissionStatus,
  type RepoHealth,
} from "../../../domain/settings/permissions";
import { parseRepoEntry, repoKey } from "../../../domain/settings/repo-entry";
import { addRepoFn, removeRepoFn } from "../../../functions/settings";
import { settingsKeys } from "../../../queries/settings";
import { Button, Code, Dialog, Empty, Form, FormError, Tag, Text, notify, twx } from "../../../ui";
import { firstError, serverError, setServerErrors } from "../../-form-field";
import { RepoPicker } from "./repo-picker";
import {
  REPO_DUPLICATE_TEXT,
  REPO_FORMAT_TEXT,
  REPO_INVALID_TEXT,
  repoNoAccessText,
  SettingsFnError,
  settingsErrorText,
} from "./settings-errors";
import { callSettingsFn } from "./token-section";

const Header = twx("div")(() => "flex items-baseline justify-between gap-3");
const List = twx("ul")(
  () => "flex flex-col divide-y divide-border rounded-lg border border-border",
);
const Item = twx("li")(() => "flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4");
const Name = twx("div")(() => "flex min-w-0 flex-1 flex-col gap-1");
const Cells = twx("ul")(() => "flex flex-wrap gap-x-3 gap-y-1 text-label-sm text-secondary-text");
const Row = twx("div")(() => "flex flex-wrap items-end gap-3");
const Grow = twx("div")(() => "flex min-w-0 flex-1 flex-col gap-1 sm:max-w-md");

const HEALTH: Record<
  RepoHealth,
  { tone: "success" | "info" | "warning" | "danger" | "neutral"; text: (r: RepoView) => string }
> = {
  ok: { tone: "success", text: () => "✓ 正常" },
  partial: { tone: "info", text: () => "✓ 部分权限无法只读验证" },
  warning: { tone: "warning", text: (r) => `⚠ 缺少 ${r.missing.join("、")}` },
  error: { tone: "danger", text: () => "✗ 无访问权限" },
  unknown: { tone: "neutral", text: () => "? 未能检查" },
};

const CELL: Record<PermissionStatus, { mark: string; label: string }> = {
  granted: { mark: "✓", label: "已授予" },
  missing: { mark: "✗", label: "缺失" },
  unverified: { mark: "⚠", label: "未验证" },
};

function RepoRow({ repo, onRemove }: { repo: RepoView; onRemove: () => void }) {
  const health = HEALTH[repo.health];
  return (
    <Item>
      <Name>
        <Code>{repo.canonical}</Code>
        {repo.permissions ? (
          <Cells aria-label={`${repo.canonical} 权限`}>
            {permissionCells(repo.permissions).map(([name, status]) => (
              <li
                key={name}
                aria-label={`${name} ${CELL[status].label}`}
                title={`${CELL[status].mark} ${CELL[status].label}`}
              >
                <span aria-hidden>
                  {CELL[status].mark} {name}
                </span>
              </li>
            ))}
          </Cells>
        ) : null}
      </Name>
      <Tag tone={health.tone}>{health.text(repo)}</Tag>
      <Button variant="ghost" size="sm" aria-label={`移除 ${repo.canonical}`} onClick={onRemove}>
        移除
      </Button>
    </Item>
  );
}

export function RepoSection({ view }: { view: SettingsView }) {
  const uid = useId();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<string | null>(null);
  const setView = (next: SettingsView) => queryClient.setQueryData(settingsKeys.view(), next);
  const full = view.repos.length >= view.maxRepos;
  const disabled = view.availability !== "ready" || full;
  const listed = useMemo(() => view.repos.map((r) => r.canonical), [view.repos]);

  const form = useForm({
    defaultValues: { repo: "" },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        const parsed = parseRepoEntry(value.repo);
        if (!parsed.ok) return { fields: { repo: REPO_FORMAT_TEXT } };
        const key = repoKey(parsed.value.canonical);
        if (view.repos.some((r) => repoKey(r.canonical) === key)) {
          return { fields: { repo: REPO_DUPLICATE_TEXT } };
        }
        return undefined;
      },
    },
    onSubmit: async ({ value, formApi }) => {
      const repo = value.repo.trim();
      try {
        const result = await callSettingsFn(addRepoFn({ data: { repo } }));
        setView(result.view);
        formApi.reset();
        if (result.warnings.length > 0) {
          notify.warning(`已添加 ${result.added.canonical}，但缺少：${result.warnings.join("、")}`);
        } else {
          notify.success(`已添加 ${result.added.canonical}`);
        }
      } catch (error) {
        const body = error instanceof SettingsFnError ? error.body : undefined;
        if (body?.field === "repo") {
          const text = body.kind === "forbidden" ? repoNoAccessText(repo) : REPO_INVALID_TEXT;
          setServerErrors(formApi, { fields: { repo: text } });
        } else {
          setServerErrors(formApi, { form: settingsErrorText(error, "添加失败") });
        }
      }
    },
  });

  const remove = useMutation({
    mutationFn: (repo: string) => callSettingsFn(removeRepoFn({ data: { repo } })),
    onSuccess: (next, repo) => {
      setView(next);
      setRemoving(null);
      notify.success(`已移除 ${repo}`);
    },
    onError: (error) => notify.error(settingsErrorText(error, "移除失败")),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void form.handleSubmit();
  };

  return (
    <>
      <Header>
        <h3 className="text-headline-sm text-heading">仓库</h3>
        <Text tone="muted">
          {view.repos.length} / {view.maxRepos}
        </Text>
      </Header>
      <Text tone="muted">
        列表决定 Slack 评审触发、/review 的 PR 列表，以及 Approve 和 Merge 的允许范围。
      </Text>

      {view.repos.length === 0 ? (
        <Empty description="未配置仓库。" />
      ) : (
        <List aria-label="仓库列表">
          {view.repos.map((repo) => (
            <RepoRow
              key={repo.canonical}
              repo={repo}
              onRemove={() => setRemoving(repo.canonical)}
            />
          ))}
        </List>
      )}

      <Form onSubmit={submit} noValidate aria-label="添加仓库表单">
        <Row>
          <Grow>
            <form.Field name="repo">
              {(field) => (
                <RepoPicker
                  label="仓库（owner/repo）"
                  inputId={`${uid}-repo-input`}
                  errorId={`${uid}-repo`}
                  message={firstError(field.state.meta.errors)}
                  name={field.name}
                  disabled={disabled}
                  listed={listed}
                  value={field.state.value}
                  onValueChange={(next) => field.handleChange(next)}
                  onBlur={field.handleBlur}
                  onPick={(fullName) => {
                    field.handleChange(fullName);
                    void form.handleSubmit();
                  }}
                />
              )}
            </form.Field>
          </Grow>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" variant="secondary" loading={isSubmitting} disabled={disabled}>
                添加仓库
              </Button>
            )}
          </form.Subscribe>
        </Row>
        {view.availability !== "ready" ? (
          <Text tone="muted">先保存一个可用的 GitHub token，才能检查并添加仓库。</Text>
        ) : full ? (
          <Text tone="muted">最多 {view.maxRepos} 个仓库。</Text>
        ) : null}
        <form.Subscribe selector={(state) => serverError(state.errorMap.onServer)}>
          {(failure) => (failure ? <FormError>{failure}</FormError> : null)}
        </form.Subscribe>
      </Form>

      <Dialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={`移除 ${removing ?? ""}？`}
        description="已有的 review、approve 和 merge 记录仍可查看；新的评审与合并会被拒绝。"
        dismissible={!remove.isPending}
        closeLabel="关闭"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setRemoving(null)}
              disabled={remove.isPending}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              确认移除
            </Button>
          </>
        }
      />
    </>
  );
}
