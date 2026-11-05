# agent-ops — 单 Next 应用重构

> **已过时（superseded by [requirements.md](../../requirements.md) / [product.md](../../product.md)）。** 这是 2026-09-15 的早期设计稿。文中的环境变量配置（`ANTHROPIC_*`、`SLACK_*` 等）已不再使用：env 只保留启动配置，GitHub、Slack 和 LLM 都在 `/settings` 配置。

## Goal

整个 `agent-ops` 仓库是一个 Next.js 应用（根目录即应用）。任务按路由扩展；账号用顶栏切换，不再用 `work/` / `personal/` 目录分区。

## Architecture

- 仓库根：`package.json`、`src/app`、共享 `src/lib`
- 顶栏切换 GitHub 账号：`zhiyong-eng`（默认）/ `wgbx`；`localStorage` 持久化
- 每次 API 带 `X-GitHub-Account`；服务端映射到对应 env token
- 样式：Tailwind CSS 4（对齐 for-next：`globals.css` + `@tailwindcss/postcss`）
- 不维护 `.env.example`

## Accounts / tokens

| Account               | Env                    |
| --------------------- | ---------------------- |
| `zhiyong-eng`（默认） | `GH_TOKEN_ZHIYONG_ENG` |
| `wgbx`                | `GH_TOKEN_WGBX`        |

Anthropic 共用：`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`，或 `ANTHROPIC_API_KEY`。

非法或缺省 header → 回退 `zhiyong-eng`。

## Routes (v1)

| Path                  | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `/`                   | 任务入口                                                             |
| `/review`             | 一键 AI PR Review（从原 `work/pr-reviewer` 迁入）                    |
| `/api/execute`        | Review 执行 API（读 `X-GitHub-Account`）                             |

## PR Review behavior (unchanged)

Paste PR URL → AI 分级 P0/P1/P2 → 始终写 comment → 无 P0 才 Approve → 永不 Merge。

## Deleted

- `work/`、`personal/` 目录树
- CSS Modules（改 Tailwind）
- `.env.example`

## Out of scope

- 多应用 / monorepo apps 壳
- Cookie 会话存账号
- personal 专属任务页
