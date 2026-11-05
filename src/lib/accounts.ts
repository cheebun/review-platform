export const GITHUB_ACCOUNTS = ["zhiyong-eng", "wgbx"] as const;

export type GithubAccount = (typeof GITHUB_ACCOUNTS)[number];

export const DEFAULT_GITHUB_ACCOUNT: GithubAccount = "zhiyong-eng";

export const ACCOUNT_STORAGE_KEY = "agent-ops:github-account";

export const ACCOUNT_HEADER = "x-github-account";

export function parseGithubAccount(value: string | null | undefined): GithubAccount {
  if (value === "wgbx" || value === "zhiyong-eng") return value;
  return DEFAULT_GITHUB_ACCOUNT;
}

export function tokenEnvKey(account: GithubAccount): string {
  return account === "wgbx" ? "GH_TOKEN_WGBX" : "GH_TOKEN_ZHIYONG_ENG";
}

export function resolveGithubToken(account: GithubAccount): string {
  const key = tokenEnvKey(account);
  const token = process.env[key]?.trim();
  if (!token) {
    throw new Error(`缺少 ${key}。请在 .env.local 中配置 ${account} 的 GitHub token。`);
  }
  return token;
}
