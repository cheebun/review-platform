import { CheckOutlined, SlackOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";
import { DIGEST_CATEGORIES, digestItemKey, type DigestItem, type SlackDigest } from "@/lib/slack-digest-types";

const local = (iso: string) => {
  const date = new Date(Date.parse(iso) + 8 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return { month: date.getUTCMonth() + 1, day: date.getUTCDate(), time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` };
};

/** e.g. "10 月 14 日 09:00—15 日 09:00（UTC+8）" */
export function windowLabel(from: string, to: string) {
  const start = local(from);
  const end = local(to);
  const endDay = end.month === start.month ? `${end.day} 日` : `${end.month} 月 ${end.day} 日`;
  return `${start.month} 月 ${start.day} 日 ${start.time}—${endDay} ${end.time}（UTC+8）`;
}

export function digestStats(digest: SlackDigest) {
  return `${digest.messageCount.toLocaleString()} 条消息 · ${digest.conversationCount} 个会话`
    + (digest.botMergedCount ? ` · ${digest.botMergedCount.toLocaleString()} 条机器人通知已归并` : "");
}

type ReadControls = {
  /** Item keys to hide. */
  readItems?: string[];
  /** Shows a 已读 button on every item when set. */
  onRead?: (item: string) => void;
  /** Item whose 已读 request is in flight. */
  reading?: string | null;
};
type Entry = { key: string; item: DigestItem };

function DigestGroup({ category, label, entries, onRead, reading }: { category: string; label: string; entries: Entry[] } & ReadControls) {
  return (
    <section className={`digest-group digest-${category}`}>
      <h3 className="digest-group-head">
        <span className="digest-group-dot" />
        {label}
        <span className="digest-group-count">{entries.length}</span>
      </h3>
      <div className="digest-items">
        {entries.map(({ key, item }) => (
          <article key={key} className="digest-item">
            <div className="digest-item-head">
              <span className="digest-item-title">{item.title}</span>
              {item.link ? (
                <a className="digest-item-link" href={item.link} target="_blank" rel="noopener noreferrer">
                  <SlackOutlined /> {item.linkLabel ?? item.conversation}
                </a>
              ) : null}
              {onRead ? (
                <Button
                  size="small" color="green" variant="filled" icon={<CheckOutlined />}
                  className="read-item-button" loading={reading === key} onClick={() => onRead(key)}
                >
                  已读
                </Button>
              ) : null}
            </div>
            {item.context ? <p className="digest-item-context">{item.context}</p> : null}
            {item.next ? (
              <p className="digest-item-next"><span className="digest-item-tag">进展</span>{item.next}</p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

/** The four categories in order; empty or fully read ones are hidden. */
export function DigestCategories({ digest, readItems = [], onRead, reading }: { digest: SlackDigest } & ReadControls) {
  const groups = DIGEST_CATEGORIES.map(({ key, label }) => ({
    key,
    label,
    entries: digest[key]
      .map((item, index) => ({ key: digestItemKey(key, index), item }))
      .filter((entry) => !readItems.includes(entry.key)),
  })).filter(({ entries }) => entries.length);
  if (!groups.length) return <Typography.Text type="secondary">这段时间没有需要关注的事项。</Typography.Text>;
  return groups.map(({ key, label, entries }) => (
    <DigestGroup key={key} category={key} label={label} entries={entries} onRead={onRead} reading={reading} />
  ));
}
