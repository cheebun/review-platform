import { Autocomplete } from "@base-ui/react/autocomplete";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import RefreshCw from "~icons/lucide/refresh-cw";
import type { AccessibleRepoOption } from "../../../application/settings/github-repos";
import { repoKey } from "../../../domain/settings/repo-entry";
import { buttonVariants, Input, Tag, Text, twx } from "../../../ui";
import { accessibleReposQueryOptions } from "./github-repo-queries";
import { SettingsFnError, settingsErrorText } from "./settings-errors";

const Field = twx("div")(() => "flex flex-col gap-1");
const FieldLabel = twx("label")(() => "text-sm text-secondary-text");
const Control = twx("div")(() => "flex items-center gap-2");
const RepoInput = twx(Input)(() => "min-w-0 flex-1");
const FieldError = twx("p")(() => "text-sm text-on-danger-soft");
const IconButton = twx("button").attrs({ type: "button" })(() =>
  buttonVariants({ variant: "secondary", iconOnly: true }),
);
const RefreshIcon = twx(RefreshCw).transientProps(["spinning"])<{ spinning?: boolean }>((props) =>
  props.spinning ? "size-4 motion-safe:animate-spin" : "size-4",
);
const Positioner = twx(Autocomplete.Positioner)(() => "z-50 outline-none");
const Popup = twx(Autocomplete.Popup)(
  () =>
    "w-(--anchor-width) rounded-md border border-border bg-surface py-1 text-sm text-on-surface outline-none",
);
const List = twx(Autocomplete.List)(() => "max-h-72 overflow-y-auto");
const Item = twx(Autocomplete.Item)(
  () =>
    "flex cursor-default items-center gap-2 px-3 py-1.5 outline-none data-[highlighted]:bg-hover-fill data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60",
);
const ItemName = twx("span")(() => "min-w-0 flex-1 truncate font-mono text-body-sm");
const EmptyText = twx(Autocomplete.Empty)(
  () => "px-3 py-1.5 text-body-sm text-secondary-text empty:hidden",
);

export const NOT_CONFIGURED_TEXT = "请先保存 GitHub token";
export const TRUNCATED_TEXT = "列表不完整，可直接输入 owner/repo";
const NEEDS_RESET_TEXT = "已保存的 GitHub token 无法解密，请重新保存。";
const REJECTED_TEXT = "GitHub 拒绝了已保存的 token，请检查它是否有效、是否已过期。";

/** Case-insensitive substring match on `owner/repo`; an empty query keeps every repo. */
export function filterRepoOptions(
  repos: readonly AccessibleRepoOption[],
  query: string,
): AccessibleRepoOption[] {
  const needle = query.trim().toLowerCase();
  return needle === ""
    ? [...repos]
    : repos.filter((r) => r.fullName.toLowerCase().includes(needle));
}

function listingErrorText(error: unknown): string {
  if (error instanceof SettingsFnError) {
    if (error.body.kind === "not_configured") {
      return error.body.reason === "needs_reset" ? NEEDS_RESET_TEXT : NOT_CONFIGURED_TEXT;
    }
    if (error.body.kind === "forbidden") return REJECTED_TEXT;
  }
  return settingsErrorText(error, "拉取仓库失败");
}

type RepoPickerProps = {
  label: string;
  inputId: string;
  /** Id of the error paragraph, referenced by the input's aria-describedby. */
  errorId: string;
  message: string | undefined;
  name: string;
  value: string;
  disabled: boolean;
  /** Canonical names already in the list; shown as disabled items. */
  listed: readonly string[];
  onValueChange: (value: string) => void;
  onBlur: () => void;
  /** An item was chosen from the list: add it. */
  onPick: (fullName: string) => void;
};

/**
 * The repo input as a combobox (FR-GITHUB-07). Free text still works: Enter with no highlighted
 * item submits the owning form. The refresh button lists the repos the stored token can access;
 * nothing is fetched until it is pressed.
 */
export function RepoPicker(props: RepoPickerProps) {
  const listing = useQuery(accessibleReposQueryOptions());
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const repos = useMemo(() => listing.data?.repos ?? [], [listing.data]);
  const filtered = useMemo(() => filterRepoOptions(repos, props.value), [repos, props.value]);
  const listedKeys = useMemo(() => new Set(props.listed.map(repoKey)), [props.listed]);
  const loading = listing.isFetching;

  const refresh = async () => {
    const result = await listing.refetch();
    if (result.isSuccess && result.data.repos.length > 0) {
      inputRef.current?.focus();
      setOpen(true);
    }
  };

  return (
    <Field>
      <FieldLabel id={`${props.inputId}-label`} htmlFor={props.inputId}>
        {props.label}
      </FieldLabel>
      <Autocomplete.Root
        items={repos}
        filteredItems={filtered}
        itemToStringValue={(r: AccessibleRepoOption) => r.fullName}
        value={props.value}
        onValueChange={(next) => props.onValueChange(next)}
        open={open && repos.length > 0}
        onOpenChange={setOpen}
        disabled={props.disabled}
      >
        <Control>
          <Autocomplete.Input
            ref={inputRef}
            id={props.inputId}
            // The open popup hides its siblings (the label among them) from assistive tech; a
            // directly referenced label still names the input.
            aria-labelledby={`${props.inputId}-label`}
            name={props.name}
            placeholder="owner/repo"
            autoComplete="off"
            spellCheck={false}
            onBlur={props.onBlur}
            {...(props.message ? { "aria-invalid": true, "aria-describedby": props.errorId } : {})}
            render={<RepoInput />}
          />
          {/* Not `Button loading`: that swaps the icon for a spinner; here the icon itself spins. */}
          <IconButton
            aria-label="从 GitHub 拉取仓库"
            title="从 GitHub 拉取仓库"
            disabled={props.disabled || loading}
            aria-busy={loading || undefined}
            onClick={() => void refresh()}
          >
            <RefreshIcon aria-hidden spinning={loading} />
          </IconButton>
        </Control>
        <Autocomplete.Portal>
          <Positioner sideOffset={4}>
            <Popup>
              <EmptyText>没有匹配的仓库，可直接输入 owner/repo 后添加。</EmptyText>
              <List>
                {(repo: AccessibleRepoOption) => {
                  const already = listedKeys.has(repoKey(repo.fullName));
                  return (
                    <Item
                      key={repo.fullName}
                      value={repo}
                      disabled={already}
                      onClick={() => props.onPick(repo.fullName)}
                    >
                      <ItemName>{repo.fullName}</ItemName>
                      {repo.private ? <Tag tone="neutral">私有</Tag> : null}
                      {repo.canPush ? null : <Tag tone="warning">⚠ 只读</Tag>}
                      {already ? <Tag tone="success">已添加</Tag> : null}
                    </Item>
                  );
                }}
              </List>
            </Popup>
          </Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
      {props.message ? <FieldError id={props.errorId}>{props.message}</FieldError> : null}
      {listing.isError ? (
        <Text tone="warning">{listingErrorText(listing.error)}</Text>
      ) : listing.data?.truncated ? (
        <Text tone="muted">{TRUNCATED_TEXT}</Text>
      ) : null}
    </Field>
  );
}
