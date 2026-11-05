# Local development

## Prerequisites

- Node 26 or newer (`engines.node` is `>=26`)
- pnpm 12 (`packageManager` pins `pnpm@12.16.1`; enable it with `corepack enable`)
- A PostgreSQL and a Redis you can reach

```bash
pnpm install
```

## 1. Create the env file

`pnpm dev` and `pnpm db:migrate` both load `.env`, `.env.local`, `.env.development` and
`.env.development.local` from the repo root (later files win). Real environment variables override
all of them. Use `.env.local`: git ignores it.

Option A: start from the example and fill in the four required values.

```bash
cp .env.example .env.local
```

Option B: reuse the remote test database in its own schema and key prefix. Set `DATABASE_URL` and
`REDIS_URL` from the values in `.env.test.local`, then add:

```
DATABASE_SEARCH_PATH=dev
REDIS_KEY_PREFIX=dev:
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=http://127.0.0.1:5555
```

Schema `dev` and prefix `dev:` keep dev data apart from test runs. The integration setup only drops
`test_*` schemas and `test:<run>:` keys, so it never touches them. See `docs/testing.md` section 5.

Never print or commit these files.

## 2. Migrations

Migrations run automatically at startup; there is no flag to turn this off. `pnpm dev`, the
production server (`pnpm start`) and the Slack review worker (`pnpm slack:review`) all apply pending
migrations from `drizzle/` before they do anything else, through one function
(`src/server/migrate-on-boot.ts`):

- It takes a Postgres advisory lock keyed by `agent-ops:migrate:<schema>` on a dedicated connection,
  so when the web server and the worker start together, one migrates and the other waits (at most
  60 s, then it fails with a clear error). Each schema has its own lock, so test schemas never block
  each other.
- All pending migrations run in one transaction. The log names the migrations it applied, or says
  "migrations up to date", with the duration.
- With `DATABASE_SEARCH_PATH` set, it creates the schema if needed and puts the tables and the
  migration journal in it.

If a migration fails, nothing starts: the log line `migrations failed` carries the Postgres code and
a value-free message. `pnpm dev` stops (a config error is the exception: the dev server stays up
and shows the 503 page below). The production server exits 1 and never listens, so it cannot serve
a stale schema. The worker exits 1 before any consumer starts.

`pnpm db:migrate` is still there and uses the same function, for example to migrate before a deploy
or to see a failure without starting the app:

```bash
pnpm db:migrate
```

The production build copies `drizzle/` into `.output/server/drizzle`, so `.output` is
self-contained.

### Destructive changes: expand, then contract

The new release migrates while the old one may still be running (and a rollback runs old code on
the new schema), so every migration must work with the code of the release before it:

- **Release N (expand):** add new columns or tables (nullable or with a default) and stop using the
  old column in code. Do not drop or rename anything the running release reads.
- **Release N+1 (contract):** drop the column or table that release N stopped using.

A rename is an add in N (writing both, reading the new one) and a drop in N+1.

## 3. Run

```bash
pnpm dev
```

The app is at http://127.0.0.1:5555. Open it: until a login token exists, every page redirects to
`/setup`. Complete the wizard:

1. **Login token (required).** Choose a token of at least 6 characters with no leading or trailing
   whitespace, and enter it twice. Only a salted PBKDF2 hash is stored.
2. **AI (Anthropic)**, 3. **GitHub token and repos**, 4. **Slack**: optional. Use "稍后配置" to
   skip any of them and set them up on `/settings` afterwards.

Nothing is saved until "完成": it validates every step, writes everything in one transaction and
signs you in. A reload clears the wizard and starts again at step 1.

From then on, sign in on `/login` with the token. Rotate it on `/settings`; rotation signs out every
session.

## GitHub, Slack and Anthropic

Integration settings are stored on `/settings`; env holds bootstrap values only. Anything skipped during `/setup` is configured there. Secrets are encrypted with `BETTER_AUTH_SECRET`; the browser receives only metadata such as status and last four characters. Missing or unreadable settings produce `not_configured`.

**Anthropic endpoint.** Set an optional base URL (`http(s)://host[/prefix]`), exactly one API key or auth token, and the runtime model. Base-URL handling is unchanged: trailing slashes are removed and the SDK appends `/v1/messages`.

- **Save** validates and persists the form without contacting the provider. Saved credentials have unverified metadata; saving is independent of the connection test.
- **Test connection** uses current form inputs, sends `hi!` with fixed model `claude-haiku-5-5`, and never saves or changes settings. The runtime model field does not affect the test.
- **Authentication** follows credential type: an API key uses `x-api-key`; an auth token uses `Authorization: Bearer`.
- Anthropic is the only LLM provider; it supplies PR review.

**CLI connection check.** `pnpm llm:ping` reads stored Anthropic settings using `DATABASE_URL`, `BETTER_AUTH_SECRET` and optionally `DATABASE_SEARCH_PATH`. It uses the same fixed connection probe and prints safe connection metadata without the credential, full URL or response body. Exit code 0 means success.

## The 503 "server not configured" page

In production the server exits at boot when its configuration is invalid or the database or Redis is
unreachable. In dev, exiting would make Nitro restart the worker in a loop (the browser shows "socket
hang up"), so the dev server stays up and answers every request with **503** and a page listing the
names of the missing or invalid variables. It never shows values. The terminal has the redacted error.

Fix the env file and restart `pnpm dev`; env files are read at startup. If the page lists no names,
the cause is not a variable (for example Redis is unreachable), so read the terminal. An
unreachable PostgreSQL or a failed migration stops `pnpm dev` before it serves anything (section 2).

## Slack HTTP Events API

Slack intake uses the public `POST /api/slack/events` callback. In the Slack app, configure
Event Subscriptions with your deployed public origin followed by `/api/slack/events`. The generic
`slack-app-manifest.json` intentionally has no deployment URL; set it in Slack after the actual
origin is known. The older Vercel manifest retains its existing
callback and must be reviewed before reuse on another host.

On `/settings`, save the User token and Signing Secret, then select review channels if needed.
The User token must belong to the owner; it supplies Slack identity, message access, replies and
reactions. The Signing Secret authenticates the raw callback body, including URL verification.
Unsigned, invalid or stale requests are rejected before a challenge is answered.

For the current Node runtime, run `pnpm slack:review` alongside the web process. It runs the
PostgreSQL review-job consumer and reaction outbox drainer; HTTP delivery alone does not start
those loops. The consumer also reclaims jobs whose lease expired, so an interrupted review resumes
without any external trigger.

### Cloudflare Workers adaptation still required

The current build is not deployable to Cloudflare Workers. `vite.config.ts` still selects Nitro's Node server entry; `src/server/runtime.ts` and the CLI worker use process
signals, process exit and long-lived resources. Startup migrations read the `drizzle/` directory
and hold a dedicated PostgreSQL advisory-lock connection before starting the server. The current
PostgreSQL pool, TCP Redis client, Redis pub/sub subscription and polling loops assume a
long-lived process. They need a deliberate Workers-compatible connection and lifecycle design.

Use a Workers runtime entry and bindings, move migrations into a separate release step, and
adapt PostgreSQL connections to the chosen Workers-compatible database transport or Hyperdrive.
Replace process-local timers and pub/sub wakeups with durable Queue delivery. Persist accepted
Slack events before acknowledging them; the current fire-and-forget post-response callback is
not durable. Queue consumers can drive existing ingest, review and outbox use cases, while a
Workflow can persist long review steps and retries. Keep database leases and idempotency checks
for repeated delivery. None of these platform changes has been made yet.
