# PR Reviewer — Ship open PRs

> **已过时（superseded by [requirements.md](../../requirements.md) / [product.md](../../product.md)）。** 这是 2026-09-15 的早期设计稿。文中的环境变量配置（`ANTHROPIC_*`、`SLACK_*` 等）已不再使用：env 只保留启动配置，GitHub、Slack 和 LLM 都在 `/settings` 配置。

> 应用已迁到仓库根；本文件只保留产品行为说明。整体架构见 [`2026-09-15-agent-ops-next-app-design.md`](./2026-09-15-agent-ops-next-app-design.md)。

## Goal

Open the `bosinc/katana-web` list:

1. Click a row to open the PR in a new tab
2. Click **Ship** under the **currently selected** GitHub account (default `zhiyong-eng`)

## Ship behavior

Always: AI review (P0/P1/P2/Nit + Verification Requests) + English GitHub comment (no tool signature).

| Authors                                                                                        | After approve?                                      |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Tianye (`tian-1m`), Jayce (`jaycechenex`), Dajiang (`zuodajiang-1m`), Zhengzhu (`zhengzhu-1m`) | Review + Approve only (no merge)                    |
| Everyone else in allowlist                                                                     | Review + Approve, then **merge commit** if approved |

Approve only when there is **no P0** (P1/P2/Nit do not block).

Force override in the result modal:

- Tianye / Jayce / Dajiang / Zhengzhu → **仍然 Approve** (no merge)
- Everyone else → **仍然 Approve + Merge**

## Open PR list

- Fixed repo: `bosinc/katana-web`
- Only non-draft open PRs from the review allowlist, updated within 15 days
- Chip filter: `全部 N` + people with count > 0 (single-select, no persistence)
- Each item shows `head → base`
- All PRs: show **已 Approve** before `updated` when GitHub `reviewDecision` is `APPROVED`
- Own PRs (`zhiyong-eng`): **复制** (`{url}\n{title}`) + **Merge** (merge commit, no AI)
- Others: **Ship**
- `GET /api/pulls/open` returns `{ authors, items }`
- `POST /api/execute` ships a PR URL (`mode: ship | force_approve | merge`)

## Stack

- Next.js (App Router) at repo root — route `/review`
- GitHub via Octokit + `GH_TOKEN_ZHIYONG_ENG` / `GH_TOKEN_WGBX`
- Anthropic via `ANTHROPIC_AUTH_TOKEN` (+ `ANTHROPIC_BASE_URL`) or `ANTHROPIC_API_KEY`
- Tailwind CSS 4 + Ant Design

## Out of scope

- Configurable owner/repo in UI
- Cookie-based account session
- Separate Approve-only / Review-only actions
