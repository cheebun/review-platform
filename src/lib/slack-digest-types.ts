export type DigestItem = {
  title: string;
  /** What happened, readable without opening the original messages. */
  context: string;
  /** Who does what next, or the outcome when already done. */
  next?: string;
  conversation: string;
  link?: string;
  linkLabel?: string;
};

export const DIGEST_CATEGORIES = [
  { key: "todo", label: "待你处理" },
  { key: "related", label: "与你有关" },
  { key: "teamTodo", label: "待团队处理" },
  { key: "teamWatch", label: "团队关注" },
] as const;
type DigestCategory = (typeof DIGEST_CATEGORIES)[number]["key"];

/** Identifies an item within its digest, e.g. "todo:0". */
export const digestItemKey = (category: DigestCategory, index: number) => `${category}:${index}`;

export function digestItemKeys(digest: Pick<SlackDigest, DigestCategory>) {
  return DIGEST_CATEGORIES.flatMap(({ key }) =>
    digest[key].map((_, index) => digestItemKey(key, index)),
  );
}

export type SlackDigest = {
  id: string;
  from: string;
  to: string;
  generatedAt: string;
  messageCount: number;
  conversationCount: number;
  /** Bot notifications folded into per-bot counts instead of being read one by one. */
  botMergedCount: number;
  /** Some messages were left out because the volume exceeded the AI input budget. */
  truncated: boolean;
  /** Coverage problems, e.g. history search unavailable. */
  warnings: string[];
  sections: { conversation: string; link?: string; summary: string; highlights: string[] }[];
} & Record<DigestCategory, DigestItem[]>;
export type SlackDigestMeta = Pick<
  SlackDigest,
  "id" | "from" | "to" | "generatedAt" | "messageCount"
>;
