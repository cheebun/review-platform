# Review platform

Private operations workbench for PR review, merge decisions and Slack PR-review intake, built with TanStack Start.

## 快速开始

env 只放启动所需的配置（bootstrap）。复制 `.env.example` 为 `.env.local`（勿提交）并填写：

| 变量                   | 说明                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`         | PostgreSQL 连接串，必填                                     |
| `DATABASE_SEARCH_PATH` | 可选：表和迁移记录所在的 schema                             |
| `REDIS_URL`            | Redis 连接串，必填                                          |
| `REDIS_KEY_PREFIX`     | 可选：所有 Redis key 的前缀（默认 `agent-ops:`）            |
| `BETTER_AUTH_SECRET`   | 会话签名和已存密钥的加密密钥，至少 32 个字符，必填          |
| `BETTER_AUTH_URL`      | 应用的公开地址，必填（开发服务器：`http://127.0.0.1:5555`） |
| `HOST`、`PORT`         | 可选：监听地址和端口                                        |

Configure GitHub, Slack and Anthropic on `/settings`; env contains bootstrap settings only. Anthropic is the only active LLM provider. Save validates and persists without a network call; Test independently checks current inputs without saving, using model `claude-haiku-5-5` and prompt `hi!`. Credential type derives the header: API key uses `x-api-key`, auth token uses `Authorization: Bearer`.

Slack intake uses the public signed HTTP Events API callback at `/api/slack/events`. Configure User token and Signing Secret on `/settings`. The current runtime still needs the review worker; see [development.md](./docs/development.md#slack-http-events-api) for setup and remaining Cloudflare Workers adaptation work.

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

打开 http://127.0.0.1:5555 ，系统未初始化时所有页面都会跳转到 `/setup` 向导：

1. 设置登录 token（必填，输入两次）：至少 6 个字符，首尾不能有空白。只保存加盐的 PBKDF2 哈希。
2. AI（Anthropic）、3. GitHub token 与仓库、4. Slack：均可选，可点「稍后配置」，之后在 `/settings` 填写。

各步骤填写的内容只保存在当前页面中，点击「完成」时才一次性校验并在同一个事务中写入，随后自动登录；任一项校验失败都不会写入任何数据，并跳回对应步骤。刷新页面会清空已填写的内容，需从第 1 步重新开始。系统初始化后，`/setup` 会跳转到 `/` 或 `/login`。

之后在 `/login` 用该 token 登录；在 `/settings` 轮换 token 会使所有会话失效。详见 [`docs/development.md`](./docs/development.md)。

## 部署安全

在设置第一个 token 之前，`/setup` 不需要任何认证：谁先打开它，谁就拥有这个系统。部署后请立即完成设置向导。公网部署请使用较长的 token。

## 任务

| 路径                                      | 说明                                      |
| ----------------------------------------- | ----------------------------------------- |
| [`/review`](http://localhost:5555/review) | 一键 AI PR Review                         |

## 文档

- [产品说明](./docs/product.md) 与 [需求](./docs/requirements.md)：当前行为的权威来源。
- [本地开发](./docs/development.md)、[测试](./docs/testing.md)、[架构](./docs/architecture.md)、[迁移计划](./docs/migration-plan.md)。
- 历史文档（已被 requirements.md / product.md 取代）：[Slack 自动 PR Review](./docs/slack-pr-review.md)，以及下列早期设计稿：

- [`docs/superpowers/specs/2026-09-15-agent-ops-next-app-design.md`](./docs/superpowers/specs/2026-09-15-agent-ops-next-app-design.md)
- [`docs/superpowers/specs/2026-09-15-pr-reviewer-design.md`](./docs/superpowers/specs/2026-09-15-pr-reviewer-design.md)
