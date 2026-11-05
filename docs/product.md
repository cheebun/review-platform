# Product overview

Status: **draft 2026-11-04**. This document describes Review platform for human readers: what it is, what each page does, and how the main flows work. The testable requirements are in [requirements.md](./requirements.md), referenced here by ID, for example FR-SHIP-04. Facts are cited as `path:line`. Anything inferred is marked **(assumed)**. Decisions the user confirmed on 2026-11-04 are marked **(decided)**.

---

## 1. Pitch

Review platform is a private, self-hosted workbench that takes the routine work off one engineer.

- **PR review.** It reviews teammates' pull requests on the repositories listed in `/settings` with an LLM and posts an English review comment. Approval and merge are explicit owner actions behind gates. Every write is pinned to the exact commit that was reviewed.
- **Slack-triggered review.** Anyone in the workspace can @mention the owner with a PR link during working hours and get the review back in the thread. A passing review (🟢) is approved automatically. Nothing is merged until the owner replies `merge`.

It runs on the owner's own server, behind a login, and it has exactly one human user.

---

## 2. Users

| Who                               | How they interact                                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner** (one person)            | Sets the login token on `/setup`, signs in on `/login` and uses every page. Connects the **one** GitHub account in `/settings` (decided). Their own PRs are the ones whose author equals that account's login (decided). Legacy hard-coded `zhiyong-eng` (`src/domain/ship/authors.ts:7-10`). |
| **Anyone in the Slack workspace** | Never signs in. They @mention the owner with a PR link for a repo in the `/settings` list, in an allowed channel or a DM, and read the result in the thread (FR-SLACK-03, decided). Only the owner can reply `merge` (FR-SLACK-13).                         |

---

## 3. Information architecture (decided 2026-11-04)

### 3.1 Navigation

The shared shell has a top bar and a left sidebar. The legacy nav is in `src/components/AppShell.tsx:9-20`, and the new one in `src/routes/-nav.ts`.

```
+------------------------------------------------------------+
| Review platform                                            |   <- top bar
+------------------+-----------------------------------------+
| Overview         |  /                                      |
| Review           |  /review                                |
| Merge            |  /merge                                 |
|                  |                                         |
| ──────────       |                                         |
| Settings         |  /settings   (pinned to the bottom)     |
| Sign out         |  (FR-AUTH-08)                           |
+------------------+-----------------------------------------+
```

- **Decided (2026-11-04): a flat sidebar.** The labels are exactly these, in English: Overview, Review, Merge, Settings.
- **Settings** sits at the bottom of the sidebar, below a divider, together with sign-out.
- The shell shows no email or other user identity.
- There is no external link.

The legacy top bar has a GitHub account switcher (`src/components/AccountSwitcher.tsx`). It is **removed**. There is exactly one GitHub account, which the owner connects in `/settings` together with the repo list (decided 2026-11-04, FR-GITHUB-01..08).

### 3.2 Route map

```
/                          Overview: summary dashboard (the workbench)
/review                    review history (view-only: filter, load more)
/review/$reviewId          review detail (read-only): verdict, findings, approval state, timeline
/merge                     reviewed PRs awaiting merge (gate status, Merge)  +  merge history
/settings                  the single GitHub account: connect, replace, remove
/setup                     setup wizard (outside the shell; unreachable once initialized)
/login                     sign in with the login token (outside the shell)
```

These seven routes are the only pages. There are **no redirects and no aliases** (decided 2026-11-04). Any other path returns 404, and an anonymous visitor is sent to `/login` first, or to `/setup` while the system is not initialized. Once it is initialized, every `/setup` URL redirects to `/` or `/login`.

The Overview page is a placeholder in the new app (`src/routes/_authed/index.tsx`).

---

## 4. Page-by-page walkthrough

The UI copy is in Chinese (`src/routes/__root.tsx:20`). The labels below are English translations.

### 4.1 Setup `/setup` and login `/login`

**First run.** Until a login token exists, every page redirects to `/setup` (FR-AUTH-01). The wizard is a centred card with a step indicator:

```
+-- Set up Review platform -------------------------------------------+
|  (1) Login token  >  (2) AI  >  (3) GitHub  >  (4) Slack            |
|  Values stay in this page until 完成; a reload starts over.         |
+---------------------------------------------------------------------+

Step 1  Login token (required)
        [ token .................. ]   at least 6 characters,
        [ token again ............ ]   no leading or trailing spaces
                                       [ 下一步 ]

Step 2  AI (Anthropic)       key or token, Base URL, model, [ 测试连接 ]
Step 3  GitHub               token, [ 验证并加载仓库 ], repo checkboxes
Step 4  Slack                User token, Signing secret, [ 测试连接 ]

        steps 2-4: (已配置)  [ 上一步 ]  [ 稍后配置 ]  [ 下一步 ]
        step 4:              [ 上一步 ]  [ 稍后配置并完成 ]  [ 完成 ]
        完成 -> finishSetup: everything in one transaction, signed in, then /
```

- Every value stays in the page's memory until 完成: nothing goes to storage, a cookie or the URL. 上一步 and 下一步 keep the values. A reload starts again at step 1 with empty fields, and the card says so.
- The only server calls before 完成 are the checks: 已配置, 测试连接 and 验证并加载仓库. They write nothing.
- 稍后配置 leaves that section out, so anything already stored stays. "已配置" marks a section that has stored values; filling it in replaces them. Anything left out can be configured later on `/settings`.
- 完成 validates every section first. If one fails, the wizard jumps to that step and shows the error on the field; nothing is written. Otherwise the token, the owner user and the settings are written in one transaction, the owner is signed in and the wizard goes to `/`.
- Once the system is initialized, every `/setup` URL redirects to `/` when signed in and to `/login` otherwise.
- If two people press 完成 at the same time, exactly one succeeds. The other sees a "系统已初始化" alert with a "前往登录" button.

**Login.** A centred card with one field (`src/routes/login.tsx`):

```
+-- Review platform ----------------+
|  Login token                      |
|  [ ••••••••••••••••••••••••••• ]  |
|  [ Sign in ]                      |
+-----------------------------------+
```

**What they can do.** Sign in with the login token (FR-AUTH-02). The app then returns to the page that was originally requested, if that is a safe same-origin path (FR-AUTH-06).

**States.**

| State   | Behaviour                                                                                                                                                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | The submit button shows a busy state and ignores double submits.                                                                                                                                                                                                                               |
| Empty   | Not applicable.                                                                                                                                                                                                                                                                                |
| Error   | Field errors are shown inline. A wrong token shows "wrong token". Repeated failures are rate-limited and show a "too many attempts, try again later" message. Other failures show a generic message.                                                                                         |

### 4.2 Overview `/` (the workbench)

**What the user sees** (legacy `src/app/page.tsx`). Two stacked sections:

1. **Slack auto review**: the status panel (FR-SLACK-11).
   - A state pill: listening, resting outside 09:00–19:00, not started, or unavailable.
   - The connected GitHub login, from `/settings`.
   - Up to 10 recent jobs, each with its state, its PR links and any failure reason. Each one links to its review record **(assumed)**.
2. **My open PRs**: the owner's own open PRs, with **Copy** and **Merge** (`src/app/review/components/PrListItem.tsx:81-109`).

In the new app the Workbench stays a **summary**. Counts of reviews awaiting action and PRs awaiting merge, linking to `/review` and `/merge`, are **(assumed)**.

**What they can do.**

- Open a job's review.
- Merge one of their own PRs.
- Mark Slack jobs read, individually or all at once.

**States.**

| State   | Behaviour                                                                                                                                                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | Each section loads on its own. Pending sections show skeletons or a spinner.                                                                                                                                                                                                        |
| Empty   | No Slack jobs: the panel says that nothing is waiting. No own PRs: "no open PRs" (`OpenPrSection`).                                                                                                                                                                                |
| Error   | A section that fails shows its own error alert with a retry. The other sections keep working. The Slack panel shows "unavailable" when Slack is not configured. GitHub-dependent sections show **"GitHub 未配置"** or **"需要重新设置"** with a link to `/settings` (FR-GITHUB-05). |

### 4.3 Review `/review` (decided)

**Built in stage 3 (`0c9b6ce`): view-only.** The page shows only the review history below. It starts nothing; reviews start from Slack. The open-PR list with a Review button described next is the earlier design and is not built (requirements.md Q26).

- Filters (PR, status, source, date) live in the URL, so a filtered view can be bookmarked. Dates are **UTC+8 calendar days**.
- The list pages with a cursor: a **"加载更多"** (load more) button appends the next page.
- Rows show no PR title, because the review record does not store it.
- Records of repos that were removed from the `/settings` list are **hidden** here, while the `/merge` history shows them. This is open: requirements.md **Q27** (recommended: show them on both pages).

**What the user sees (earlier design).**

- **Top: open PRs.** This is the legacy PR list (`src/app/review/page.tsx`, components in `src/app/review/components/`):
  - a **repo picker**, and the open PRs across every repo in the `/settings` list, limited to the 9 tracked authors and to PRs updated in the last 15 days (FR-REVIEW-01)
  - author chips with counts (`AuthorFilter`)
  - for each row: the number and title, the author, an "approved" badge, the time since the last update, and head → base (`main` is emphasised)
  - a **Review** button, the legacy **Ship**, that starts a review
  - **Refresh**
- **Below: review history.** The review records and results, newest first (FR-REVIEW-05, FR-REVIEW-06). Each row has the time, the PR, the source badge (`web` or `slack`), the requester ("you" or a Slack user), the status, the verdict and the findings counts. There are filters for PR, status, source and date, and the list is paginated.
  - Each row's verdict uses the same markers as Slack (decided): 🟢 pass, 🔴 changes requested, 🟡 强制批准 (force-approved, with the override noted), ✅ 已合并 once merged, and no marker for a failed review.

**What they can do.**

- Filter the open PRs by author, and start a review. While the review runs, the row shows progress, and the client polls with a bound (FR-REVIEW-03).
- When the review finishes, open its detail page, `/review/$reviewId`.
  - Legacy showed a result dialog (`ShipResultModal`) or an error dialog (`ShipErrorModal`) instead. Whether the web review also stops before approving is open question Q15 **(assumed: yes)**.
- Filter and page through the history, and open any record.

**States.**

| State     | Behaviour                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading   | Skeletons for the PR list and the history table. A per-row busy button (`aria-busy`) while a review runs. A filter change keeps the old rows until the new ones arrive **(assumed)**.                                                       |
| Empty     | "No open PRs to review" (`OpenPrSection`). "No reviews yet" in the history. With filters set: "No reviews match these filters", with a Clear filters action.                                                                                |
| Error     | Each part has its own alert with a request ID and a Retry button (S4). **Legacy:** the raw server error text was shown.                                                                                                                     |
| No GitHub | **"GitHub 未配置"** (no token), **"需要重新设置"** (the stored token cannot be decrypted) or **"未配置仓库"** (an empty repo list) replaces the open-PR list, with a link to `/settings`. The review history stays readable (FR-GITHUB-05). |

### 4.4 Review detail `/review/$reviewId` (decided, read-only)

**Read-only (decided 2026-11-04).** This page has **no buttons and no actions**. It only shows the result. Approve, force approve and re-review are Slack thread commands only (`approve`, `force approve`, `review`, `updated`; §5.3). The only web action on a PR is **Merge** on `/merge`.

**What the user sees** (FR-REVIEW-07):

- The PR link (no title: it is not stored), the reviewed head SHA, the source, the requester, the model, and the start and finish times.
- The **verdict**, and the **findings** grouped by severity. The code has P0, P1, P2 and Nit; the user asked for P0–P3 (Q8). Each finding has a file:line link into GitHub.
- The verification requests.
- The **status emoji**: ⏳, 🟢, 🔴 or 🟡, plus ✅ once merged.
- **Approval state.** A 🟢 review is **approved automatically** (decided, FR-SHIP-01), and the page shows 已批准 with the SHA and "auto: review passed". If the auto-approve was skipped (head moved, own PR) or failed, the reason is shown, with the hint to reply `approve` in the Slack thread.
- On 🔴, the page explains that only the Slack `force approve` reply can override.
- **Force approval, shown only.** If the owner force-approved this PR from Slack, a 🟡 **强制批准** banner shows the SHA, the overridden verdict and the time. There is **no** force-approve button on the web (decided, FR-SHIP-06).
- A **✅ 已合并** badge, with the merge SHA, once the PR is merged.
- The PR's **event timeline**: reviewed, commented, approved, merged, failed, each with its actor and time.

**States.**

| State   | Behaviour                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | Header and findings skeletons.                                                                                                                                               |
| Empty   | A review with zero findings shows "No findings" and the verdict.                                                                                                             |
| Error   | Unknown ID: 404. **Stale review**: the banner "PR has new commits since this review", and the hint to reply `review` or `updated` in the Slack thread. No action is offered. |

### 4.5 Merge `/merge` (decided)

**What the user sees.**

- **Top: awaiting merge.** The reviewed PRs that are not merged yet (FR-SHIP-05). Each row shows a gate checklist:

  ```
  #1234  Fix cart total rounding        author: alice     reviewed @ a1b2c3d
    [x] 已批准 @ a1b2c3d   [x] head SHA unchanged   [x] no P0   [x] mergeable   [ ] checks green
    [ Merge ]  (disabled: required checks pending)
  ```

- **Below: merge history.** Each entry has the merge time, the PR, the merge commit SHA, the actor, the source (`web`, or `slack` when the owner replied `merge` in the thread), and a **✅ 已合并** badge. Merging a Slack-origin PR here also adds ✅ to its original Slack message (FR-SHIP-08).

**What they can do.**

- 🟡 强制批准 PRs are listed here with the note "P0 overridden". Their "no P0" gate shows as waived for that SHA.
- **Merge** a PR whose gates are all green. The button is enabled only when **every** gate passes, and it opens a confirmation dialog that shows the **full** head SHA. **It never approves.** Without an approval for the current SHA (the 已批准 row), the button is disabled, with the message "请先 approve（或 force approve）" (decided).
- The merge is pinned to the SHA shown in the dialog. If the PR head moved meanwhile, the merge is refused ("refresh and check again") before anything is written.
- Merges are limited to 10 per minute per user.
- Page through the merge history.
- Open the review behind any row.

**States.**

| State     | Behaviour                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loading   | Skeletons. The gate checks load live, and each shows a spinner until GitHub answers. The queue checks at most 50 PRs, 6 at a time.                                                                                                                                                                     |
| Empty     | "Nothing awaiting merge". "No merges yet" in the history.                                                                                                                                                                                                                                              |
| Error     | A failed gate lookup marks that gate "unknown", and Merge stays disabled. If GitHub has not computed mergeability yet, the mergeable gate fails ("try again shortly"). A merge refused by GitHub shows a fixed reason, never GitHub's raw text, and appends `merge_failed`. Errors carry a request ID. |
| No GitHub | "GitHub 未配置", "需要重新设置" or "未配置仓库", with a link to `/settings`. Merge buttons are hidden. The merge history stays readable.                                                                                                                                                               |

### 4.6 Settings `/settings` (decided)

**What the user sees.** A "GitHub" section with two parts (FR-GITHUB-01..08), then **Slack** and **LLM** sections below it (FR-SLACKCFG, FR-LLMCFG; decided 2026-11-04). After this, nothing about an integration is configured in env:

```
+-- GitHub ----------------------------------------------------------+
| 1. Token                                                           |
|   (avatar)  octo-owner      token ••••a1b2     saved 2026-11-04    |
|   [ Replace token ]  [ Remove ]                                    |
|                                                                    |
| 2. Repositories                                     [ owner/repo ] [Add]
|   acme/web        PR r ✓ w ⚠ 未验证  contents r/w ✓  checks r ✓  statuses r ✓  [Remove]
|   acme/api        PR r ✓ w ⚠ 未验证  contents r ✓ w ✗  checks r ✓  statuses r ✓  [Remove]
|                   ⚠ missing contents:write — merge will be refused   |
+--------------------------------------------------------------------+

+-- Slack -----------------------------------------------------------+
| User Token     ••••9f3c  saved 2026-11-04  ✓ Acme workspace, @owner |
|                [ Replace ]  [ Remove ]                             |
| Signing Secret ••••77aa  saved 2026-11-04  ✓ verified on first event|
|                [ Replace ]  [ Remove ]                             |
|                                                                    |
| Review channels   [ search channels…        ]                      |
|   [x] #eng-review   [x] #web-team   [ ] #random                    |
|   ⚠ #old-project   no longer accessible                            |
|   Empty selection = all channels. DMs always count.                |
+--------------------------------------------------------------------+

+-- LLM -------------------------------------------------------------+
| Anthropic                                                         |
|   Base URL (optional)     Credential: API key or auth token        |
|   Model (runtime model)                                           |
|   [ Save ]   [ Test connection ]                                   |
|   Test: claude-haiku-5-5, prompt hi!, no settings saved             |
+-------------------------------------------------------------------+
```

**1. Token.**

- **Not connected.** A token field, short guidance and **Save**. The guidance recommends a fine-grained PAT that can access only the repos you list, with Contents read and write (for merge), Pull requests read and write (for approve), Checks read and Commit statuses read. The exact names are to be verified against GitHub docs when the page is built.
- **Connected.** Only the login, the avatar, the last 4 characters and the saved-at time. The token itself is never sent back to the browser.
- **Save** checks the token with `GET /user` first, and saves nothing if that fails.
- **Replace** runs the same check, and then **re-checks every listed repo**, flagging any that lost access.
- **Remove** asks for confirmation first.

The token is encrypted with AES-256-GCM, using a key derived from the existing `BETTER_AUTH_SECRET` with HKDF-SHA256. There is no extra env var.

**2. Repositories.**

- **Add** an `owner/repo`:
  - The format is checked, and so are duplicates (case-insensitive) and the limit of 50 repositories (assumed).
  - The server then checks that the saved token can access the repo, and shows the result for each permission.
  - A repo the token cannot access is rejected with a clear error, shown on the input field (403 `forbidden`).
  - **Implemented (commit `7c638a5`).** Only read-only calls are used. With a fine-grained token, "PR write" is always **⚠ 未验证**, because GitHub has no read-only probe for it. "Contents write" is inferred from the merge settings that `GET /repos` returns. A 5xx, a timeout or a rate limit also shows as unverified (`src/adapters/github/octokit-github-verifier.ts:50-73`). The page renders unverified cells today as "? 无法验证" (`src/routes/_authed/-settings/repo-section.tsx:49`); the wireframe's "⚠ 未验证" is the target wording.
- **Remove** a repo. Its past reviews and merges stay visible, but new reviews, approvals and merges for it are refused.
- Every add and every remove is recorded in the event history.

The list decides three things:

- which Slack PR links trigger a review
- which repos appear on `/review`
- which repos may be approved and merged

**3. Slack (decided 2026-11-04).**

- **Two secrets**, each saved, replaced or removed on its own. The page only ever shows the masked last 4 characters, the saved time and the connection-test result. The values never come back to the browser.
  - **User Token** (`xoxp-`): checked with `auth.test`, which must return a user, not a bot. The page shows the workspace and user name.
  - **Signing Secret**: only its format is checked on save. It shows **⚠ 未验证** until the first validly signed Slack event arrives, and is then marked verified.
- **Review channels.** Once the user token is saved, the owner picks channels from a searchable multi-select of the public and private channels they are in. The page states the rule: **an empty selection means all channels, and DMs always count.**
  - One listing reads at most 10 pages of 200 channels, or 15 seconds. If it was cut off, the page says the list is incomplete (`truncated`).
  - A selected channel that disappears (deleted or left) is kept and flagged as missing, never silently dropped.
- **Limits.** Saves: 10 per 10 minutes. Channel listings: 30 per 10 minutes.
- The secrets are encrypted like the GitHub token, each with its own key label (`agent-ops:<kind>:v1`), in the `setting_secret` table. If any of them cannot be decrypted, Slack shows **"需要重新设置"**.
- Changes take effect without a restart: the events route picks up a new signing secret, and every change is announced on `slack-settings:changed`, so the worker drops its cached credentials.
- Every change is recorded in the event history, without the values.
- Slack is configured here, not in env.

**4. LLM.**

- **Anthropic only.** Configure the optional base URL, exactly one API key or auth token, and the runtime model used for review. Trailing slashes are removed from the base URL.
- **Save** validates and persists values without contacting the provider. The credential is encrypted and stored as unverified; no successful probe is required.
- **Test connection** uses the current form inputs and does not save them. It sends `hi!` using the fixed test model `claude-haiku-5-5`, independently of the runtime model field, and shows status and latency without exposing the credential. When the test passes with exactly the saved settings, the saved credential changes from **⚠ 未验证** to verified; testing unsaved inputs, or a failed test, changes nothing. Saving a credential makes it unverified again.
- **Authentication follows the credential.** API key uses `x-api-key`; auth token uses `Authorization: Bearer`.
- Changes take effect on the next call, without a restart. Missing or unreadable credentials show a configuration state with a link here.

**States.**

| State       | Behaviour                                                                                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading     | Section skeletons. Save and Add show a busy state while GitHub is checked.                                                                                                                                                                                                                                     |
| Empty       | No token: **"GitHub 未配置"** with the token form. The repo list is disabled until a token exists. No repos: **"未配置仓库"**, which also means that no Slack review triggers and that Approve and Merge are refused everywhere.                                                                               |
| Needs reset | **"需要重新设置"**: a stored GitHub token or Slack secret can no longer be decrypted, for example after `BETTER_AUTH_SECRET` was rotated. Replace or Remove are offered for each, and nothing crashes.                                                                                                         |
| Error       | Token: "Token rejected by GitHub" or "GitHub unreachable, try again". Repo: "Invalid format", "Already in the list", "Limit reached" or "The token cannot access owner/repo". In every case nothing is saved, and errors carry a request ID. A repo that lost access after a token change is flagged in place. |

**登录令牌 (login token).** `/settings` also has a "登录令牌" section with three fields: current token, new token and confirmation. Success signs out every session, including the current one, and the browser reloads `/login` (FR-AUTH-07). A wrong current token is shown inline on that field; too many attempts show "N 分钟后再试".

## 5. Key flows

### 5.1 Review → auto-approve → merge (web)

```
Owner                  Review platform                         GitHub        LLM
  | Review PR #n         |                                        |            |
  | (/review)            | allowlist (S2), not own PR             |            |
  |--------------------->| get PR + files, pin head SHA --------->|            |
  |  202 (polling)       | review_job(source=web), full diff ----------------->|
  |<---------------------|<-------------------------------------------- findings
  |                      | post comment @ SHA ------------------->|            |
  |  record + detail     | store review record + events           |            |
  |<---------------------|                                        |            |
  |                      | 🟢? head == reviewed SHA? not own PR ->| APPROVE    |
  |                      |   (auto; event "auto: review passed")  |            |
  | detail (read-only)   | no actions; retry = Slack `approve`    |            |
  | Merge (/merge)       | gates: SHA, no P0, mergeable, checks ->| merge @SHA |
  |  merge SHA           | append `merged` event                  |            |
```

- Every action re-checks that the head SHA is still the reviewed one. A moved head blocks the action; a re-review is requested in Slack (FR-SHIP-03).
- `/review` (the list) can still start a new review from the open-PR list. Whether the list should also be view-only is open (requirements.md Q26).
- A P0 always means REQUEST_CHANGES and blocks Merge.
- **Decided:** a 🟢 review approves automatically (web-triggered reviews: assumed). Merge is always a separate, manual step. Legacy Ship approved and merged in the same step.

### 5.2 Slack mention → review → result in the thread (decided)

```
Anyone in workspace   Slack           Review platform (events route / review worker)  PG
   | "@owner <katana-   |                  |                                                |
   |  web PR url>"      |  event --------->| verify signature, dedupe event_id (Redis NX)    |
   |                    |                  | rules: allowed channel or DM, active hours,     |
   |                    |                  |   mention, PR URL in repo list (else: silent)   |
   |                    |                  | rate limit                                      |
   |                    |                  |-- enqueue review_job (queued) --------------->|
   |                    |<-- "on it" + ⏳  |  ⏳ on the original message, before the LLM    |
   |                    |                  | consumer claims (SKIP LOCKED + lease) <--------|
   |                    |                  | review each PR, post GitHub comment             |
   |                    |                  | 🟢: auto APPROVE @ reviewed SHA (never merge)   |
   |                    |<-- thread reply: |  verdict + findings summary                     |
   |                    |<-- 🟢 or 🔴 on   |  verdict reaction on the ORIGINAL PR message    |
   |                    |    original msg  |  (replaces any previous 🟢/🔴; no ✅ yet)       |
   |                    |                  |  + link /review/$reviewId                       |
   |                    |                  |-- review record + events -------------------->|
```

- **No GitHub token**, or a token that needs resetting: the bot replies in the thread that GitHub is not configured, and no review runs (FR-GITHUB-05).
- **The owner's own messages never start a review** (decided). The owner uses the `review` thread command.
- **Ack first.** The events route verifies the signature, acks Slack at once, then processes the event. Duplicates are stopped by the Redis `event_id` claim, and the job id is a second layer. An event acked just before a crash is lost (known gap).
- **Who does the work.** The worker process runs the review consumer and the reaction outbox drainer, for HTTP-ingested jobs. It also reclaims jobs whose lease expired.
- **Result reply.** If Slack refuses the reply 3 times, it is dropped and logged (known gap).
- **Decided:** anyone in the workspace may trigger a review. There is no sender allowlist. Only PR links for repos in the `/settings` list count. Other links are ignored silently, and an empty list triggers nothing.
- **Decided (2026-11-04): auto-approve on 🟢, never auto-merge.** When the review passes, the app submits a GitHub APPROVE at the reviewed SHA, then swaps ⏳ for 🟢.
  - **Skipped** if the head moved since the review (the thread says to re-review), or if it is the connected account's own PR (the thread says so). The other policy checks still apply: the repo is in the list with write access, and the PR is open, not a draft and not merged.
  - **Failed** (a GitHub error): 🟢 still shows, because it reflects the verdict. The thread says the approval failed, and the owner can retry with `approve`.
  - Already approved at that SHA: nothing happens.
  - The approval is recorded with actor = system on behalf of the owner, and the reason "auto: review passed".
  - Every 🟢 PR ends with one outcome: approved, skipped (with a reason from `src/domain/ship/policy.ts`), or failed. A failed approve never fails the review.
  - **Residual risk.** Injected PR content could steer a review to 🟢 and so to an approval. A merge still needs the owner, so the human gate stays on merge (requirements.md Q1).
- **Verdict reactions (decided).** When the review finishes, the original Slack message with the PR link gets 🟢 if the review passes (no P0, mergeable), or 🔴 if changes are requested.
  - A re-review removes the old 🟢 or 🔴 first, so only the latest verdict shows.
  - A failed review gets no emoji, only a thread reply.
  - ✅ is reserved for a confirmed merge (§5.3), and 🟢 stays next to it.
  - A failed reaction is retried and never changes the review result. If a newer review supersedes an older one while its reactions are pending, the outbox recomputes them from what is actually on the message (`convergeOps`).

  **Emoji lifecycle (decided).** A PR has at most one status emoji at a time: ⏳, 🟢, 🔴 or 🟡. ✅ is only ever added next to 🟢 or 🟡.

  ```
  request accepted        ->  ⏳                       (before the LLM runs)
  review done (pass)      ->  auto APPROVE, then ⏳ removed, 🟢 added
  review done (P0)        ->  ⏳ removed, 🔴 added
  review errored          ->  ⏳ removed (no emoji, thread reply)
  "updated", no commits   ->  nothing changes (reply "上次审核后没有新提交")
  "updated" + new commits ->  🔴/🟢/🟡 removed, ⏳ added   (see 5.2a)
  approve (manual retry)  ->  🟢 stays                 (Q25)
  force approve (owner)   ->  🔴 removed, 🟡 added     (see 5.3a)
  merged                  ->  🟢 ✅  or  🟡 ✅      (final: no re-review, ✅ never removed)

  normal:  ⏳ → 🔴 → ⏳ → (auto APPROVE) 🟢 → (merge) 🟢✅
  forced:  ⏳ → 🔴 → 🟡 → (merge) 🟡✅
  ```

  If a job's lease expires and it is reclaimed, ⏳ stays until the final outcome. Each such reclaim counts as an interruption. The third one fails the job as interrupted: ⏳ is removed, and the review record and the error reply are still written.

  With several PRs in one message, the rule is open (Q23). The assumption: 🔴 if any PR is red, 🟢 only if all are green, ✅ only when all are merged.

- If a consumer dies mid-review, another one reclaims the job after the lease expires and resumes from its checkpoints (FR-SHIP-07).

### 5.2a Re-review with `updated` (decided)

```
Slack message M (PR link)                          Review platform               GitHub
  "@owner please review <PR>"  ----------------->  accepted, job enqueued
  M: ⏳                        <-----------------  (before the LLM runs)
                                                   review #1: P0 found
  M: ⏳ removed, 🔴 added       <-----------------  verdict = changes requested
        ...author pushes new commits...                                  head: a1b2 -> c3d4
  requester replies "updated"      ------------>  sender == requester? exact text? not running?
                                                   head SHA changed? yes -> accepted
  M: 🔴 removed, ⏳ added             <-----------  outbox (remove first, then add)
                                                   review #2: no P0
  M: ⏳ removed  (reactions.remove)  <-----------  outbox step 1 (retried until done)
  M: 🟢 added    (reactions.add)     <-----------  outbox step 2 (after step 1)
  thread reply: verdict + /review/$reviewId
```

- **Decided:** a failed review (changes requested) puts 🔴 on the message. When the re-review passes, 🔴 → ⏳ → 🟢. Each PR always has exactly one status emoji.
- **Decided: how to ask for a re-review.** The person who asked for the original review replies **`updated`** in the same thread, and nothing else: no link and no @mention. Only that person: anyone else's `updated`, including the owner's, is ignored. The owner uses `review` (below).

  ```
  "updated" from the requester
     ├─ review already running ─────► reply "review in progress" (assumed), nothing queued
     ├─ outside 09:00–19:00 ────────► reply (assumed), nothing queued
     ├─ no new commits ─────────────► reply "上次审核后没有新提交", emoji unchanged
     └─ new commits ────────────────► ⏳ replaces the emoji on the ORIGINAL message, review runs
  ```

  - **Status emoji.** It stays on the original message. The `updated` reply never gets an emoji.
  - **Several PRs.** If the thread has several PRs, only the ones with new commits are re-reviewed (assumed, Q23).

- **Decided: the owner's `review`.** The owner replies **`review`** in any thread that contains a PR link for a listed repo. It starts a review round, with the same emoji rules (⏳, then 🟢 or 🔴).

  ```
  "review" from the owner (assumed details)
     ├─ review already running ─────► reply "正在审核中", nothing queued
     ├─ thread never reviewed ──────► ignored (decided; a manual first review is not built)
     ├─ no new commits ─────────────► re-run on the same SHA, reply says so
     └─ new commits ────────────────► ⏳ replaces the emoji on the ORIGINAL message, review runs
  ```

- **Proposed, pending user confirmation:**
  - **New message.** A new top-level message with the same PR link counts as a fresh request. The emoji moves to the new message.
  - **Bookkeeping.** The app records every reaction it placed (channel, message and emoji), so it only ever removes its own.
- **Order.** The old emoji is always removed first, then the new one is added. Both steps are retried until they succeed.

### 5.3 Slack thread commands (decided)

Every command is a reply in the thread, and the whole message must be exactly the command, in any case. The owner has four commands, and the requester has one:

| Reply           | Who may send it                                  | What it does                                                                                                    |
| --------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `review`        | Owner only                                       | Starts a review round, even on the same SHA or outside active hours. Ignored in a never-reviewed thread (5.2a). |
| `approve`       | Owner only                                       | Manual retry when the auto-approve was skipped or failed. Already approved: reply only. Never merges.           |
| `force approve` | Owner only                                       | APPROVE despite 🔴, for this SHA only. 🔴 becomes 🟡 (5.3a).                                                    |
| `merge`         | Owner only                                       | Merges only. Needs an approval for the current SHA. Adds ✅ when GitHub confirms.                               |
| `updated`       | The original requester only (not even the owner) | Re-review if there are new commits; otherwise replies "上次审核后没有新提交" (5.2a).                            |

A 🟢 review approves automatically. Merge is **always a separate**, manual step:

```
review 🟢 ──(automatic)───────► APPROVE @ reviewed SHA    (🟢 stays; Q25)
auto skipped/failed ─"approve"► APPROVE @ head SHA (retry)
already approved ─"approve"──► reply only, no GitHub call
review 🔴 ──"approve"────────► refused: "use force approve"
review 🔴 ──"force approve"──► APPROVE @ head SHA, 🔴 → 🟡   (5.3a)
approved ──"merge"──────────► merge @ SHA → ✅
not approved ─"merge"───────► refused: "请先 approve（或 force approve）"
new commits ──any command───► refused: re-review needed
```

On the web, `/review/$reviewId` is read-only (decided). The only web action is the Merge button on `/merge`, enabled only after an approval for the current SHA. Force approve exists only in Slack.

The `merge` step in detail:

```
Owner          Slack            Review platform                              GitHub
  | reply "merge" |                 |                                          |
  | in the thread |  event -------->| exact trimmed text == "merge" (any case)? |
  |               |                 | not an edit / not bot / sender == owner?  |
  |               |                 |   (anyone else: ignored, attempt logged)  |
  |               |                 | thread -> review record? exactly 1 PR?    |
  |               |                 |   (several PRs: ask which one)           |
  |               |                 | approval recorded for CURRENT head SHA?   |
  |               |                 |   (no: "请先 approve（或 force approve）")    |
  |               |                 | gates: no P0 (unless forced @ SHA),       |
  |               |                 |   mergeable, checks green ---------------->|
  |               |                 | merge @ SHA ----------------------------->|
  |               |                 |<-- merged=true, sha ----------------------|
  |               |<-- "merged      | append merged event (never approves)      |
  |               |    <sha>" or    |   (actor = owner via Slack)               |
  |               |    the refusal  |                                          |
  |               |    reason       |                                          |
  |               |<-- ✅ on the    | only after GitHub confirms the merge;     |
  |               |    ORIGINAL     |   a failed reaction is logged + retried,  |
  |               |    PR message   |   the merge stays successful              |
```

- Because the text must be exactly `merge`, the app's own thread replies cannot trigger a merge, even though they are posted with the owner's token.
- If the head moved after the review, the bot refuses and suggests a re-review.
- **✅ means merged (decided).** The ✅ reaction goes on the original Slack message that contained the PR link, and only after GitHub confirms the merge. This holds whether the merge came from this `merge` reply or from the web `/merge` button. It is never added after a review, an approve, or a refused or failed merge; in those cases the reason is posted in the thread. `already_reacted` counts as success.
- Whether active hours apply to `merge` is open **(assumed: no)**. The disambiguation syntax for threads with several PRs is open (requirements.md Q16).

### 5.3a Force approve from Slack (decided)

```
Owner (thread)            Review platform                                  GitHub      message M
  "force approve"  ---->  exact text? owner? not edit/bot? review in thread?
                          checks: repo in list, open/not draft, not own PR,
                                  head SHA valid; latest verdict 🟢? -> "already approved by review"
                          APPROVE @ current head SHA  ---------------------> ✓
                          event force_approved {actor, sha, overridden verdict, time}
                          outbox: remove 🔴, then add 🟡  ------------------------------->  🟡
  <---- "force-approved at c3d4; reply `merge` to merge"
  "merge"          ---->  gates: allowlist, open, mergeable, checks green,
                          no P0 → WAIVED only if force_approved.sha == head
                          merge @ SHA  ------------------------------------> merged, sha
                          outbox: add ✅  ------------------------------------------------>  🟡 ✅
```

- **Slack only.** There is no force-approve button on the web. `/review` and `/merge` show 🟡 **强制批准**, with the override noted.
- **Approve only.** Force approve never merges by itself. Merging is a separate `merge` reply, or the `/merge` button.
- **Review of the current head required (decided).** Force approve is refused if new commits arrived since the latest review. The owner replies `review` (or the requester `updated`) first.
- **New commits void the override.** If the head SHA changes, the P0 waiver no longer applies, and a normal review is needed.

## 6. Integrations

| Integration            | Used for                                                                                                                                                                                                                         | Credential and config                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**             | Listing PRs, reading diffs and blobs, posting comments, submitting reviews, merging (pinned to the SHA). **One** account, connected in `/settings` (decided). The legacy two-account setup (`src/lib/accounts.ts:1`) is removed. | The token is stored encrypted in PostgreSQL, with a key derived from `BETTER_AUTH_SECRET`. The repo list is stored in `/settings`, with no env var. |
| **Slack**              | Receiving mentions (HTTP Events API), thread replies, and ✅ reactions as the owner on the original message after a confirmed merge, reading messages, and the review-channel list.                                      | Stored on `/settings`, encrypted: User Token, Signing Secret, review channels (FR-SLACKCFG).                                                        |
| **Anthropic**          | Used for PR review whenever it is configured. The default model is `claude-opus-5-5` (`src/adapters/llm/options.ts:13`).                                                                                          | Stored on `/settings`, LLM section; keys encrypted (FR-LLMCFG-01).                                                                                  |
| **PostgreSQL / Redis** | Durable state (jobs, review records, the login token hash) and coordination (dedupe, locks, rate limits, wake-ups).                                                                                                         | `DATABASE_URL`, `REDIS_URL`                                                                                                                         |

### 6.1 Tokens and credentials (decided)

| Token                                | Where it lives                                                                                   | Who uses it                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Login token** (from `/setup`)      | PostgreSQL, as a salted PBKDF2-HMAC-SHA256 hash only. The plaintext is never stored or logged.   | The owner types it on `/login`. Rotated on `/settings`, which signs out every session.                                                                    |
| **Session token** (from `/login`)    | An HttpOnly, SameSite=Lax cookie, Secure on https. It lasts 7 days and is refreshed daily.       | The browser sends it, and the server checks who you are. JavaScript cannot read it.                                                                       |
| **GitHub token** (from `/settings`)  | PostgreSQL, encrypted with AES-256-GCM. The key is derived from `BETTER_AUTH_SECRET`.            | **Only the server** uses it: pages rendered on the server, server functions, and the Slack worker. It is never sent to the browser, not even in a cookie. |
| **Slack secrets** (from `/settings`) | PostgreSQL, encrypted the same way, one key label per secret.                                    | **Only the server**: the events route, the review worker and the Slack adapter. Never sent to the browser.                                                |
| **LLM secrets** (from `/settings`)   | PostgreSQL, encrypted the same way, one key label per secret.                                    | **Only the server**, inside the LLM adapters. Never sent to the browser.                                                                                  |

```
Browser --session cookie--> server --decrypt--> GitHub
Slack   --signed event----> server --decrypt--> GitHub      (no browser, no cookie)
```

The GitHub token is not kept in a cookie. A Slack review or a Slack `merge` reply has no browser request, so it would have no cookie and could not reach GitHub. Details are in requirements.md §3.7.

---

## 7. Glossary

| Term                  | Meaning                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Owner**             | The one human user. The first account created.                                                                                                                                                                                                   |
| **Ship**              | Review a PR, then post the comment, the GitHub review and possibly a merge, according to policy.                                                                                                                                                 |
| **Approve**           | Submit a GitHub APPROVE review at the reviewed head SHA, without merging. Automatic when a review passes (🟢); the Slack `approve` reply retries it.                                                                                             |
| **Merge**             | The explicit merge action, pinned to the head SHA and gated. It runs from `/merge` or from the owner's Slack `merge` reply.                                                                                                                      |
| **`review` command**  | An owner-only Slack thread reply that is exactly `review`. It starts a review round for the thread's PR, even on the same SHA or outside active hours. It is ignored in a thread with no earlier review, and after a merge.                      |
| **`updated` command** | The original requester's Slack thread reply that is exactly `updated`. It re-reviews only if there are new commits. The owner cannot use it.                                                                                                     |
| **`approve` command** | An owner-only Slack thread reply that is exactly `approve`. It retries a skipped or failed auto-approve at the current SHA if the latest review is 🟢, and never merges.                                                                         |
| **`merge` command**   | An owner-only Slack thread reply that is exactly `merge`. It merges only, needs an approval for the current SHA, and **never approves**.                                                                                                         |
| **Gate status**       | The merge preconditions shown for each PR: head SHA unchanged, no P0, mergeable, checks green.                                                                                                                                                   |
| **Force approve**     | The owner's Slack reply `force approve`, which is Slack only. It submits APPROVE at the current head SHA despite a P0, marks the message 🟡, and never merges. The P0 merge gate is waived only for that same SHA.                               |
| **Finding**           | One review issue: a severity, a title, a body, and an optional file:line.                                                                                                                                                                        |
| **Severity**          | `P0` (blocking, leads to REQUEST_CHANGES), `P1`, `P2` and `Nit` (`src/lib/types.ts:1`). See Q8 on P0–P3.                                                                                                                                         |
| **Verdict reaction**  | 🟢 `large_green_circle` (pass) or 🔴 `red_circle` (changes requested). It sits on the original Slack message, and only the latest review's verdict is kept.                                                                                      |
| **Verdict**           | The GitHub event that follows from the findings: `APPROVE`, `REQUEST_CHANGES` or `COMMENT`.                                                                                                                                                      |
| **Head SHA pinning**  | Every GitHub write is tied to the commit that was reviewed. A moved head stops the operation.                                                                                                                                                    |
| **Stale review**      | A review whose head SHA no longer equals the PR's current head. It cannot be used to approve or merge.                                                                                                                                           |
| **GitHub 未配置**     | No GitHub token is stored. GitHub features show this text and link to `/settings`.                                                                                                                                                               |
| **需要重新设置**      | A token is stored but cannot be decrypted, for example after the auth secret was rotated. It must be set up again in `/settings`.                                                                                                                |
| **Repo list**         | The `owner/repo` entries saved in `/settings`. They are the only repos Review platform reviews, approves or merges. Empty means none (decided).                                                                                                        |
| **未配置仓库**        | The repo list is empty. Slack triggers, `/review` and Approve/Merge are all off until a repo is added.                                                                                                                                           |
| **Session token**     | The better-auth cookie (HttpOnly, SameSite=Lax, Secure on https) that proves the owner is signed in. JavaScript cannot read it.                                                                                                                  |
| **GitHub token**      | The PAT entered in `/settings`, stored encrypted in PostgreSQL and used only by the server. It never reaches the browser.                                                                                                                        |
| **Review job**        | A queued unit of review work in PostgreSQL. Its states are queued, running, done and failed. Three interruptions, including expired leases, fail it.                                                                                             |
| **Lease**             | A consumer's time-bounded claim on a running job. When it expires, the job can be reclaimed.                                                                                                                                                     |
| **Checkpoint**        | Per-PR progress saved after each GitHub write, so retries never repeat a write.                                                                                                                                                                  |
| **HTTP ingress**      | Slack events arrive through the public signed HTTP Events API callback. They are deduplicated by `event_id`.                                                                                                                                     |
| **Active hours**      | 09:00–19:00 UTC+8. Slack mentions sent outside them are ignored.                                                                                                                                                                                 |
| **Request ID**        | The ID in every error response. It matches a server log line.                                                                                                                                                                                    |
