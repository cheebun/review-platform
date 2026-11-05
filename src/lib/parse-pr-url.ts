import type { PrRef } from "./types";

const PR_URL_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/?(?:files|commits|checks)?)?(?:[#?].*)?$/i;

export function parsePrUrl(input: string): PrRef {
  const trimmed = input.trim();
  const match = trimmed.match(PR_URL_RE);
  if (!match) {
    throw new Error("无效的 PR URL。期望格式：https://github.com/{owner}/{repo}/pull/{number}");
  }

  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
}
