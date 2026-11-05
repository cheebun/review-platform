import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState, type FormEvent } from "react";
import type {
  SlackChannelOption,
  SlackSettingsView,
} from "../../../../application/settings/slack-settings";
import { filterChannels } from "../../../../domain/settings/slack-settings";
import { setSlackChannelsFn } from "../../../../functions/settings-slack";
import {
  Alert,
  Button,
  Empty,
  Form,
  FormError,
  Input,
  Skeleton,
  Tag,
  Text,
  notify,
  twx,
} from "../../../../ui";
import { serverError, setServerErrors } from "../../../-form-field";
import { CHANNELS_INVALID_TEXT, SlackFnError, slackErrorText } from "./slack-errors";
import { callSlackFn, slackChannelsQueryOptions, slackSettingsKeys } from "./slack-queries";

const Box = twx("section")(
  () => "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4",
);
const Rule = twx("p")(() => "text-body-sm text-secondary-text");
const Group = twx("fieldset")(
  () =>
    "flex max-h-80 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border",
);
const Option = twx("label")(
  () =>
    "flex cursor-pointer items-center gap-3 px-3 py-2 text-body-sm text-heading hover:bg-primary-soft",
);
const Check = twx("input")(() => "size-4 accent-primary");
const Footer = twx("div")(() => "flex flex-wrap items-center justify-between gap-3");

type Row = SlackChannelOption & { missing: boolean };

const channelLabel = (c: { name: string; isPrivate: boolean }) =>
  c.isPrivate ? `🔒 ${c.name}` : `#${c.name}`;

/**
 * FR-SLACKCFG-04: multi-select of the channels the user token is in, with a name filter.
 * Selected channels the listing no longer has stay listed, flagged, so they can be unselected.
 */
export function ChannelPicker({ view }: { view: SlackSettingsView }) {
  const uid = useId();
  const queryClient = useQueryClient();
  const ready = view.availability === "ready";
  const listing = useQuery({ ...slackChannelsQueryOptions(), enabled: ready });
  const [query, setQuery] = useState("");
  const selectedIds = view.channels.map((c) => c.channelId);

  const form = useForm({
    defaultValues: { channels: selectedIds },
    onSubmit: async ({ value, formApi }) => {
      try {
        const next = await callSlackFn(setSlackChannelsFn({ data: { channels: value.channels } }));
        queryClient.setQueryData(slackSettingsKeys.view(), next);
        formApi.reset({ channels: next.channels.map((c) => c.channelId) });
        notify.success("评审频道已保存");
      } catch (error) {
        const invalid = error instanceof SlackFnError && error.body.field === "channels";
        setServerErrors(formApi, {
          form: invalid ? CHANNELS_INVALID_TEXT : slackErrorText(error, "保存失败"),
        });
      }
    },
  });

  const rows = useMemo<Row[]>(() => {
    const listed = listing.data?.channels ?? [];
    const known = new Set(listed.map((c) => c.id));
    // A selected channel the listing lacks: gone, unless the listing was cut short.
    const complete = listing.isSuccess && !listing.data.truncated;
    const absent = view.channels
      .filter((c) => !known.has(c.channelId))
      .map((c) => ({
        id: c.channelId,
        name: c.name,
        isPrivate: false,
        missing: c.missing || complete,
      }));
    return [...absent, ...listed.map((c) => ({ ...c, missing: false }))];
  }, [listing.data, listing.isSuccess, view.channels]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void form.handleSubmit();
  };

  return (
    <Box aria-labelledby={`${uid}-title`}>
      <Text weight="medium" id={`${uid}-title`}>
        评审频道
      </Text>
      <Rule>空选择 = 所有频道。私信始终计入。</Rule>

      {!ready ? (
        <Rule>保存 user token 后可选择频道。</Rule>
      ) : (
        <Form onSubmit={submit} noValidate aria-label="评审频道表单">
          <Input
            type="search"
            aria-label="搜索频道"
            placeholder="按名称搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {listing.isError ? (
            <Alert
              tone="warning"
              title="频道列表加载失败"
              action={
                <Button variant="secondary" size="sm" onClick={() => void listing.refetch()}>
                  重试
                </Button>
              }
            >
              {slackErrorText(listing.error, "加载失败")}
            </Alert>
          ) : null}
          {listing.data?.truncated ? (
            <Rule>频道过多，只显示了前一部分。请用搜索缩小范围。</Rule>
          ) : null}
          <form.Field name="channels">
            {(field) => {
              const chosen = new Set(field.state.value);
              const visible = filterChannels(rows, query);
              const toggle = (id: string) =>
                field.handleChange(
                  chosen.has(id)
                    ? field.state.value.filter((v) => v !== id)
                    : [...field.state.value, id],
                );
              return (
                <>
                  <Group aria-label="评审频道">
                    {listing.isPending && rows.length === 0 ? (
                      <Skeleton lines={3} aria-label="正在加载频道" />
                    ) : visible.length === 0 ? (
                      <Empty description="没有匹配的频道。" />
                    ) : (
                      visible.map((c) => (
                        <Option key={c.id}>
                          <Check
                            type="checkbox"
                            aria-label={
                              c.missing ? `${channelLabel(c)} 已不可访问` : channelLabel(c)
                            }
                            checked={chosen.has(c.id)}
                            onChange={() => toggle(c.id)}
                          />
                          <span aria-hidden>{channelLabel(c)}</span>
                          {c.missing ? <Tag tone="warning">⚠ 已不可访问</Tag> : null}
                        </Option>
                      ))
                    )}
                  </Group>
                  <Footer>
                    <Text tone="muted">
                      {chosen.size === 0 ? "未选择：所有频道都计入" : `已选 ${chosen.size} 个频道`}
                    </Text>
                    <form.Subscribe selector={(state) => state.isSubmitting}>
                      {(isSubmitting) => (
                        <Button type="submit" loading={isSubmitting}>
                          保存频道
                        </Button>
                      )}
                    </form.Subscribe>
                  </Footer>
                </>
              );
            }}
          </form.Field>
          <form.Subscribe selector={(state) => serverError(state.errorMap.onServer)}>
            {(failure) => (failure ? <FormError>{failure}</FormError> : null)}
          </form.Subscribe>
        </Form>
      )}
    </Box>
  );
}
