# Testing

Status: **approved 2026-11-03**. Last updated 2026-11-03.

Every change is test-first. This document defines the test layers, the tools, how test doubles are built and kept honest, how remote test databases are isolated, and the red-green-refactor workflow that agents follow. It accompanies [architecture.md](./architecture.md).

---

## 1. Toolchain

Versions are the npm `latest` dist-tag as checked on 2026-11-03.

| Purpose                  | Package                                                                                              | Version (date)                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Runner                   | vitest + @vitest/coverage-v8                                                                         | 5.1.0 (2026-11-02). Peer range covers Vite 8 |
| Component tests          | @testing-library/react, @testing-library/dom, @testing-library/user-event, @testing-library/jest-dom | 16.3.3 / ^10 / 14.6.8 / 7.0.1                |
| DOM environment          | jsdom                                                                                                | 30.1.3 (2026-10-15)                          |
| HTTP mocking             | msw                                                                                                  | 3.0.3 (2026-10-10)                           |
| In-process Postgres      | @electric-sql/pglite (via `drizzle-orm/pglite`)                                                      | 0.5.14 (2026-10-31)                          |
| E2E                      | @playwright/test                                                                                     | 1.64.1 (2026-10-14)                          |
| Mutation testing (later) | @stryker-mutator/core + vitest-runner                                                                | 10.1.1 (2026-10-23)                          |

**`node:test` is retired.** The 9 existing test files are converted to vitest mechanically at the start of P1: `describe`/`it` come from `vitest`, and `node:assert` may stay. Each converted file must keep its test count and pass before anything else changes.

**Unverified items.** Each is checked in P1 step 0 with a smoke test before anything depends on it:

- msw on Node 26 undici `fetch`
- Base UI under jsdom
- better-auth's drizzle adapter on PGlite

---

## 2. Layers (vitest `projects`)

| Project       | Scope                                                                                  | Environment           | Doubles                                                                                           | Speed target                 | When it runs           |
| ------------- | -------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------- |
| `unit`        | `domain/**`, `application/**`, `server/errors`, `server/config`, pure helpers          | node                  | in-memory fakes of every port                                                                     | the whole suite in under 5 s | watch mode, every save |
| `db-fast`     | `adapters/db/**` repositories                                                          | node                  | PGlite (in-process Postgres)                                                                      | under 15 s                   | watch mode, pre-commit |
| `integration` | `adapters/db`, `adapters/redis`, the job-claim SQL, concurrency scenarios, better-auth | node                  | **real remote PG + Redis** (§5); external HTTP via msw                                            | under 2 min                  | pre-push, CI           |
| `component`   | `ui/**`, route components                                                              | jsdom                 | server functions mocked at the `functions/` boundary; QueryClient per test; memory history router | under 20 s                   | watch mode, pre-commit |
| `e2e`         | login, review and Ship flows through the built app                                     | Playwright (Chromium) | remote test PG + Redis; msw-backed fake GitHub/Slack/LLM server                                   | under 5 min                  | CI, before deploy      |

Most tests belong in `unit`. A behaviour gets a test in a higher layer only when it **cannot** be shown lower down, for example SQL semantics, Redis atomicity, real HTTP wiring or browser behaviour.

---

## 3. Test doubles

### 3.1 Fakes, not mocks

Every port in `src/ports/` has a **hand-written in-memory fake** in `src/testing/fakes/`, for example `InMemoryReviewJobRepo`, `FakeClock`, `FakeLock`, `InMemoryEventDedupe` and `FakeReviewer`.

- **Fakes have real behaviour.** A fake lock really excludes, and a fake repo really enforces unique keys. A fake records calls only where the test needs to assert them.
- **`vi.mock` on modules is not allowed** in `unit` and `db-fast`. If a test needs it, the code has a hard-wired dependency that should have been a port. There is one exception, the `component` project mocking the `functions/` boundary.
- **Builders** in `src/testing/builders/` create valid domain objects with overrides, such as `aReviewJob({ state: 'running' })`, so tests state only what matters.

### 3.2 Contract tests keep fakes honest

Each port has one **shared contract suite** in `src/testing/contracts/<port>.contract.ts`. It runs against every implementation of that port:

```ts
export function reviewJobRepoContract(
  make: () => Promise<{ repo: ReviewJobRepo; clock: FakeClock; cleanup(): Promise<void> }>,
) {
  describe("ReviewJobRepo contract", () => {
    it("claims each queued job exactly once under concurrency", async () => {
      /* ... */
    });
    it("reclaims a running job after lease expiry and increments attempts", async () => {
      /* ... */
    });
    // ...
  });
}

// unit:        reviewJobRepoContract(() => inMemory())
// db-fast:     reviewJobRepoContract(() => pglite())
// integration: reviewJobRepoContract(() => remotePostgres())
```

If the fake passes but the real adapter fails (or the reverse), the contract is incomplete. Add the missing case to the contract, not to one implementation's own tests.

### 3.2.1 Contract timing on remote services

Contract suites use small TTLs, such as 300 ms, so the fakes stay fast. Against remote Redis or PostgreSQL, the round trip (about 120 ms to Aiven) would eat most of that budget.

- **Do not loosen the contract.** The runner for a remote implementation multiplies every TTL and every `advance()` by a `TIME_SCALE` constant, kept in its harness (`src/testing/integration/redis-harness.ts`). This preserves the ratios the contract asserts.
- **Repositories that take an injected `Clock`** (all PostgreSQL ones) need no scaling. `advance()` moves the `FakeClock`, and `now` is passed to SQL as a parameter.

### 3.3 Time, ids and randomness

- **Injected, not stubbed.** Time comes from `FakeClock`, ids from a seeded `IdGenerator`. `vi.useFakeTimers` is allowed only in `component` tests, for UI timers such as polling intervals.
- **Hard-wired call sites to remove.** The following become `Clock` or `IdGenerator` calls as their modules move into `domain/` and `application/`:
  - `slack-review-queue.ts:56,75,82,103,106,119`
  - `slack-review-runner.ts:73,144`
  - `slack-review-store.ts:115`
  - `github.ts:19`
  - `review-session.ts:96,107`
  - `slack-signature.ts:14`

### 3.4 External HTTP (msw)

Active adapters for GitHub (Octokit), Slack (`@slack/web-api`) and Anthropic are tested with **msw handlers** that return recorded, minimal real-shaped responses. They are stored in `src/testing/http/<service>/`. Clients use `fetch`, and the interception smoke test verifies that unhandled requests cannot reach the network.

Unhandled requests **fail the test** (`onUnhandledRequest: 'error'`), so no test can reach the real internet.

### 3.5 LLM settings

- Save validates and persists without network calls, leaving verification metadata unset.
- Test uses current form inputs, fixed model `claude-haiku-5-5` and prompt `hi!`, without writing settings.
- API key uses `x-api-key`; auth token uses `Authorization: Bearer`.

---

## 4. What to test where

| Concern                                                | Layer                            | Technique                                                                                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review job state machine (architecture §4)             | unit                             | **Table-driven:** every (state, event) pair with its expected result. **Property-based:** random event sequences never break the invariants (terminal states, at-most-once checkpoints, monotonic attempts) |
| `ShipPolicy` (allowlist, author rules, merge decision) | unit                             | table-driven, covering every repo/author/severity combination                                                                                                                                               |
| Use cases (`shipPullRequest`, `ingestSlackEvent`, ...) | unit                             | fakes; assert the resulting state and the recorded external writes                                                                                                                                          |
| Repositories, migrations, job-claim SQL                | db-fast + integration            | contract suites; N-way parallel claims                                                                                                                                                                      |
| Redis Lock / EventDedupe / RateLimiter                 | unit (fake) + integration (real) | contract suites, including concurrent `SET NX` races and Lua release-with-wrong-token                                                                                                                       |
| Config loading                                         | unit                             | each missing or invalid env var produces a readable error; secrets are never echoed                                                                                                                         |
| Error mapping (architecture §7)                        | unit                             | every `DomainError.kind` maps to a status; no raw message leaks                                                                                                                                             |
| Auth middleware, Slack signature on the raw body       | integration                      | real server-route handler invoked with a `Request`                                                                                                                                                          |
| Server functions                                       | unit                             | logic lives in a plain use case; the `createServerFn` wrapper only adds validation and auth, which is covered once per wrapper type                                                                         |
| UI primitives (`twx`, Button, Dialog...)               | component                        | rendering, variants, keyboard behaviour (Base UI), `aria-*`                                                                                                                                                 |
| Pages with loaders                                     | component                        | memory history router + QueryClient seeded per test                                                                                                                                                         |
| Critical user journeys                                 | e2e                              | login → review a PR → Ship; unknown routes are not navigable                                                                                                                                                 |

---

## 5. Remote test databases

The remote test PostgreSQL and Redis are used by **one person**, so isolation is simple and still safe.

- **Credentials** live in `.env.test.local`, which git ignores via the `.env.*` rule. The vitest `integration` and `e2e` setups load them as `TEST_DATABASE_URL` and `TEST_REDIS_URL`. They are never read by the app's `DATABASE_URL`/`REDIS_URL` code path, never logged, and never written into docs, tests or commits.
- **Production guard.** Global setup refuses to run when `TEST_DATABASE_URL` equals `DATABASE_URL`, or `TEST_REDIS_URL` equals `REDIS_URL`, if those are set.
- **TLS.** Both connections require it: Postgres uses `ssl: 'require'`, and Redis uses the `rediss` (TLS) URL scheme.
- **PostgreSQL isolation.** Each test run creates schema `test_<runId>`, runs the drizzle migrations into it, sets `search_path` per connection, and drops the schema in global teardown. A crashed run leaves a schema behind, so setup also drops `test_*` schemas older than 24 h.
- **Redis isolation.** Each run uses key prefix `test:<runId>:`, via `REDIS_KEY_PREFIX` in architecture §5.2. Teardown deletes the prefix with `SCAN` + `UNLINK`, never `FLUSHDB`.
- **Parallelism.** Integration test files run in parallel. Each file gets its own schema and prefix, derived from `runId` + file hash.

### 5.1 Investigation: integration failures on 2026-11-04/05

- **Cause: the host, not the code.** The failures came from host network latency to the remote test services (about 524 ms per round trip against about 120 ms normally) and probable host sleep during the run. Timeouts and lease expiries followed from that; no code defect was found.
- **Disproved: pool deadlock.** The hypothesis that a locked transaction waited on a second pool connection held by itself was checked and ruled out: every query inside a locked transaction goes through `tx`, never the outer pool.
- **Mitigation.** On macOS, run long integration suites under `caffeinate -i` so the host does not sleep mid-run, for example `caffeinate -i pnpm test:integration`. Check the round-trip latency first when many integration tests time out at once.

---

## 6. Workflow (red → green → refactor)

Every behaviour change follows these steps. Agents must report the evidence for steps 1 and 2.

1. **Red.** Write the smallest failing test that states the behaviour. Run it and **capture the failure output**, which must fail for the expected reason (an assertion failure, not an import error).
2. **Green.** Write the minimum code to pass, then run the project's suite.
3. **Refactor.** Clean up with every test green, and do not change behaviour.
4. **Commit.** Each commit is **green**, so `git bisect` stays usable. The red output goes in the agent report or PR description, not in a failing commit.

### Bug fixes

Bug fixes follow AGENTS.md: the reproducing test comes first, and its red output is included in the report. The test name references the bug, for example `it('does not echo the GitHub token in a validation error')`.

### Coverage gates (CI, `@vitest/coverage-v8`)

| Scope                | Lines                  | Branches |
| -------------------- | ---------------------- | -------- |
| `src/domain/**`      | 95 %                   | 90 %     |
| `src/application/**` | 90 %                   | 85 %     |
| `src/adapters/**`    | 80 % (contract suites) | —        |
| overall              | 80 %                   | 75 %     |

Coverage is a floor, not the goal. Mutation testing (Stryker) runs on `src/domain/**` once the domain is stable, at the end of P3, with a target mutation score ≥ 80 %.

---

## 7. Commands

| Script                  | Runs                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `pnpm test`             | `vitest run --project unit --project db-fast --project component` |
| `pnpm test:watch`       | `vitest --project unit --project db-fast --project component`     |
| `pnpm test:integration` | `vitest run --project integration`, which needs `.env.test.local` |
| `pnpm test:e2e`         | `playwright test`, against a production build                     |
| `pnpm test:coverage`    | all vitest projects with coverage gates                           |

The CI order is `typecheck` → `typecheck:tsc` → `lint` → `format:check` → `test` → `test:integration` → `build` → `test:e2e`.

---

## 8. First tests per phase

| Phase | Red tests written first                                                                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | Step 0 smoke tests (msw, PGlite + drizzle 1.0 RC, better-auth on PGlite, Base UI on jsdom); `ReviewJobRepo` / `Lock` / `EventDedupe` contract suites; job-claim concurrency; config loading |
| P2    | Unauthenticated page redirects to /login; unauthenticated API returns 401; any `Authorization` header returns 401; Slack events without a session but with a valid signature pass                                        |
| P3    | Review job state-machine table + properties; `ShipPolicy` allowlist (S2); account resolved from the actor (S3); error mapping without leaks (S4); rate limit (S6); `ANTHROPIC_MODEL` trim bug              |
| P4    | `twx` guard (exists); each primitive's variants and keyboard behaviour                                                                                                                                     |
| P5    | Polling stops after N attempts and on unmount; removed routes resolve to the guarded catch-all                                                                                                             |
| P6    | HTTP Events API repeated-delivery dedupe end to end; a crashed worker's job is reclaimed after its lease expires                                                                                                               |
