# Slack 自动 PR Review

> **Historical reference only.** This document records the earlier Vercel-hosted implementation and must not be used for current setup or deployment. Current behavior is defined in [requirements.md](./requirements.md), [product.md](./product.md) and [development.md](./development.md); Slack callback setup is in [development.md](./development.md#slack-http-events-api).

## 行为

- 任何成员在私信、频道、群聊或线程中明确 `@你`，并附上 PR 链接，都会触发 Review；未明确 `@你` 的消息不会触发。
- 包含 `https://github.com/bosinc/katana-web/pull/{number}`；支持 `/changes`、`/files`、`/commits`、`/checks` 后缀，以及 Slack `<url|label>`、Markdown 链接和一条消息内多个 PR。
- 忽略机器人消息、编辑 / 删除事件、其他仓库的链接。
- 自动 Review 只按消息是否明确 `@你` 和可访问的频道范围匹配；PR 作者不使用白名单过滤。
- PR 必须来自 `bosinc/katana-web`、处于 open 且非 Draft；不批准当前 GitHub Token 所属账号自己的 PR。
- 沿用 Ship：英文 GitHub 评论；P0 → Request Changes；无 P0 → Approve；按既有作者规则决定是否使用 merge commit。
- 所有 PR 的 Ship 流程完成后，以你的 Slack 用户身份给**触发消息**加 `white_check_mark`（✅）。有 P0 且已成功提交 Request Changes，也视作 Review 完成。批准后应合并但合并失败时，不加 ✅。
- 命中自动 Review 规则并首次入队后，立即在触发消息的线程回复 `on it`；Slack 重试或重复投递不会重复回复。
- 所有 PR 的 Review 完成后：没有任何问题时回复 `approved`；有 P0 时回复带 GitHub 评论链接的 `see comment`；只有 P1/P2 时回复 `approved with minor issues`；之后继续按原逻辑加 ✅。
- Ship 失败时回复面向用户的 `review failed: <原因>`，不暴露内部流程名称，也不添加 ✅；完整错误仍保存在任务状态中，方便在 `/review` 查看和重试。
- 只响应 UTC+8 09:00–19:00（不含 19:00）发送的消息，按消息发送时间判断；时段外的消息直接忽略，不会排队到第二天。`/review` 在时段外显示「休息中」。
- 处理失败可在 `/review` 查看；终态会在线程中回复结果或 `review failed: <原因>`。点「已读」隐藏已完成和失败的任务（已读时间存在 Redis，多设备同步）。

## 访问控制

应用本身不做登录校验。Vercel 编译的是 `release` 分支，部署目标为 **Preview**，受 Vercel Deployment Protection（Vercel Authentication）保护：只有登录了项目所属 Vercel 账号的浏览器才能访问页面和 API，因此不需要额外的访问控制。

Slack 无法登录 Vercel，`/api/slack/events` 通过 Protection Bypass for Automation 放行（见「部署到 Vercel」），并依赖 Slack 签名校验。

## 运行方式

Slack 通过 Events API 把事件推送到 `/api/slack/events`，任务状态存 Upstash Redis。电脑关机也能处理。见下文「部署到 Vercel」。

## Slack App 配置

1. 在 <https://api.slack.com/apps> 使用仓库根的 `slack-app-manifest.json` 创建 App，选择工作区。
2. 安装 App，以**你自己的 Slack 账号**完成用户 OAuth 授权；工作区可能要求管理员审批。已有 App 更新 manifest 后，需要重新安装或重新授权以获得 `chat:write`，才能发送 `on it`。
3. 在 OAuth & Permissions 复制 User OAuth Token（通常 `xoxp-...`），填入 `/settings` 的 Slack 区块（user token）。
4. 在 Basic Information → App Credentials 复制 Signing Secret，填入 `/settings` 的 Slack 区块。
5. 确认用户事件订阅已启用。

此 App 仅授权给你的一个 Slack 用户；程序会校验事件中的用户授权，忽略其他用户授权下的事件。

需要的是用户事件，`app_mention` 只表示 @机器人，不表示 @你。Bot Token 只能看到机器人参与的对话，无法代替用户授权读取别人发给你的私信。

私密频道和私信只会收到你有权访问的事件。Manifest 默认覆盖公共频道、私密频道、私信和群聊；可按需要删除不使用的范围。

## 部署到 Vercel

1. Vercel 项目 → Storage / Marketplace → 创建 **Upstash Redis**（免费档即可）并连接到本项目，会自动注入 `KV_REST_API_URL` 和 `KV_REST_API_TOKEN`。
2. 在项目环境变量中配置，环境选 **Preview**、分支限定 `release`（`release` 的部署是 Preview，只配 Production 不会生效）启动配置（见 development.md）。Slack 凭据、Review 频道、GitHub token 和 LLM 凭证在 `/settings` 填写，无需重新部署。
3. Vercel 项目 → Settings → Deployment Protection → **Protection Bypass for Automation**，生成一个 bypass secret。
4. 在 Slack App → Event Subscriptions 填 Request URL：`https://<你的域名>/api/slack/events?x-vercel-protection-bypass=<bypass secret>`，Slack 会立即发验证请求，显示 Verified 即可。
5. 打开 `/review`，状态显示「监听中 · Vercel」。

执行方式：

- 事件路由校验 Slack 签名，命中规则的消息写入 Redis 后立即返回 200（Slack 要求 3 秒内确认），Ship 在同一次函数调用的 `after()` 中继续执行，路由 `maxDuration` 为 300 秒。
- 同一条消息以 Redis 原子写入去重，执行时持有 Redis 锁，Slack 重试或多实例并发都不会重复执行。
- 审查结果、评论、批准和合并分别保存检查点。接近单次执行预算时不再开始新的 AI 审查，任务回到排队状态。函数超时被中断的任务从检查点续跑，已完成的整份审查不会重复执行；尚未完成的 AI 调用需要重新执行。连续中断 3 次标记失败，获得完整审查结果后重置计数。续跑由新的命中消息或打开 `/review` 页面（最多每分钟一次）触发。
- 失败任务重试：本地 `.env.local` 配上同一个 Redis 的 `KV_REST_API_URL` / `KV_REST_API_TOKEN`（可用 `vercel env pull`），运行 `pnpm slack:review:retry`，再打开 `/review` 页面触发执行。

`/review` 的状态从 Redis 读取。

## 重试与恢复

- 消息以工作区 + 频道 + 时间戳去重，先保存再确认事件，AI 在队列中串行执行。
- 进程重启会恢复中断任务；评论、GitHub Review、合并均保存检查点。
- 若仅 ✅ 添加失败，会自动重试回执，不重新调用 AI。
- Ship 失败默认保留失败状态，避免持续重复操作。处理原因后运行 `pnpm slack:review:retry`，再打开 `/review` 页面触发执行。

该命令会重新排队所有失败任务并从检查点继续。PR SHA 已改变的任务不会沿用旧审查，可使用下方网页 Ship 重新审查。已完成消息不会被该命令再次执行。

工作台和 `/review` 页的「Slack 自动 Review」列表中，每个 PR 旁都有 **Ship** 按钮。PR 在首次发消息时尚未准备好、之后又更新代码时，可以直接点击，以当前页面选择的 GitHub 账号重新审查最新提交，无需重发 Slack 消息。手动 Ship 使用新的网页审查会话，不沿用自动任务的旧检查点，结果通过页面提示或弹窗展示；原自动执行记录保留，处理后可标记已读。仍在排队、执行或等待 Slack 回执的 PR 暂时禁用手动按钮。

## 自动批准的条件

PR 不设置总量或单次 Diff 的字符上限，也不按字符数截断或分批。完整读取文件列表和 Diff 后，将全部文件、PR 标题、描述及分支信息一次提交给模型，便于一起检查跨文件关系。旧版未完成的分批检查点会被丢弃，重新审查完整 Diff；已完成的审查仍可从后续步骤恢复。

GitHub 没有返回文件的文本 Diff 时，程序会按固定提交恢复：纯路径移动通过共同祖先版本的 blob SHA 核对内容不变，并把旧、新路径交给模型；其他 UTF-8 文本文件读取共同祖先和 PR 新版本的完整 Git blob，重建 Diff。源码中的实际 NUL 字节只在模型输入中用明确标记显示，原始文件不变。比较使用 PR 的共同祖先，而非目标分支的最新内容，避免混入目标分支后续提交。

获得完整审查结果后，有 P0 则 Request Changes，无 P0 则按既有规则批准。AI 调用失败、结果缺失或包含不完整的问题、输出被截断、GitHub 文件列表缺失、Diff 无法完整恢复（包括无法解析为文本的二进制文件）、审查期间 PR 更新时，均停止批准。缺失 Diff 的错误会列出相关文件及恢复失败原因，或收到的文件数。

Claude 网关若将 `findings` 数组编码为 JSON 字符串，会先严格解析并校验每条问题。审查输出格式无效时，要求模型纠正一次完整结果；再次无效仍停止批准，不会将解析失败当作“没有问题”。Slack 自动流程与网页 Ship 共用此处理。

模型和中转服务仍可能有 token 上下文、请求大小或速率限制，Vercel 路由的单次执行时长仍为 300 秒。程序不预设字符阈值；实际超限或超时会作为审查失败处理，不会据此批准 PR。

网页 Ship 在服务端保存审查会话（配置 Redis 时使用 Redis，否则保存到本地 `.agent-ops/review-sessions/`，会话有效期 24 小时），浏览器自动请求续跑，直到审查和后续操作完成。Slack 沿用原有检查点持久化方式。Review 绑定被审查的提交 SHA，合并使用同一 SHA。GitHub 分支保护继续决定是否允许批准 / 合并。

源码中的 GitHub 令牌和 Slack 用户令牌必须具有对应仓库和工作区权限。当前 App 配置不实现 Token Rotation；若工作区要求轮换，需要增加 OAuth 刷新流程。

参考：

- <https://docs.slack.dev/apis/events-api/>
- <https://docs.slack.dev/reference/methods/reactions.add/>
