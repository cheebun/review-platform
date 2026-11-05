import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { credentialStoreContract } from "../../testing/contracts/credential-store.contract";
import { reviewEventRepoContract } from "../../testing/contracts/review-event-repo.contract";
import { settingsRepoContract } from "../../testing/contracts/settings-repo.contract";
import { aSettingsEvent } from "../../testing/contracts/harness";
import { AesGcmTokenCipher } from "../crypto/aes-gcm-token-cipher";
import { PgCredentialStore } from "./pg-credential-store";
import { PgReviewEventRepo } from "./pg-review-event-repo";
import { PgSettingsRepo } from "./pg-settings-repo";
import { appStateRepoContract } from "../../testing/contracts/app-state-repo.contract";
import { reviewJobRepoContract } from "../../testing/contracts/review-job-repo.contract";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { PgAppStateRepo } from "./pg-app-state-repo";
import { PgReviewJobRepo } from "./pg-review-job-repo";
import { pgliteFixture } from "./pglite-fixture";

// One PGlite instance for all repositories: each instance costs seconds of CPU at startup and
// several in parallel starve other db-fast files (the PGlite smoke test has a 5 s timeout).
const fixture = pgliteFixture();

reviewJobRepoContract(async () => {
  const clock = new FakeClock();
  return {
    repo: new PgReviewJobRepo(fixture.db(), clock),
    advance: (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});

appStateRepoContract(async () => ({
  impl: new PgAppStateRepo(fixture.db(), new FakeClock()),
  advance: async () => {},
  cleanup: async () => {},
}));

const harness = <T>(impl: T) => ({ impl, advance: async () => {}, cleanup: async () => {} });

// The settings stores write `review_event` in their own transaction; `events` reads it back.
const withEvents = <T>(impl: T) => ({
  ...harness(impl),
  events: new PgReviewEventRepo(fixture.db()),
});
credentialStoreContract(async () => withEvents(new PgCredentialStore(fixture.db())));
settingsRepoContract(async () => withEvents(new PgSettingsRepo(fixture.db())));
reviewEventRepoContract(async () => harness(new PgReviewEventRepo(fixture.db())));

describe("github settings tables (PG only)", () => {
  // A fake token and secret: test sentinels, not credentials.
  const SENTINEL = "github_pat_SENTINEL0123456789abcdefWXYZ";

  it("the credential row holds no plaintext token (FR-GITHUB-03 AC1)", async () => {
    const cipher = new AesGcmTokenCipher({ secret: "test-secret-0123456789abcdefghijklmnop" });
    await new PgCredentialStore(fixture.db()).save(
      {
        encrypted: cipher.encrypt(SENTINEL),
        login: "octocat",
        avatarUrl: "https://avatars.example.test/u/1",
        last4: SENTINEL.slice(-4),
        tokenKind: "fine_grained",
        scopes: null,
        savedAt: new Date("2026-11-04T00:00:00Z"),
        savedByUserId: "owner-1",
      },
      () => aSettingsEvent("github_token_saved"),
    );
    const rows = await fixture
      .db()
      .execute(sql`SELECT row_to_json(c)::text AS j FROM github_credential c`);
    const text = JSON.stringify(rows);
    expect(text).toContain("octocat");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(SENTINEL.slice(0, 20));
  });

  it("allows only one credential row", async () => {
    await expect(
      fixture.db()
        .execute(sql`INSERT INTO github_credential (id, ciphertext, iv, auth_tag, key_version,
        login, avatar_url, last4, permissions, saved_at, saved_by_user_id)
        VALUES ('other', 'c', 'i', 't', 1, 'l', 'a', '1234', '{}', now(), 'u')`),
    ).rejects.toThrow();
  });

  it("review_event rejects UPDATE and DELETE (append-only)", async () => {
    const repo = new PgReviewEventRepo(fixture.db());
    await repo.append({
      id: "ev-1",
      type: "github_repo_added",
      actor: { kind: "user", id: "owner-1" },
      at: new Date("2026-11-04T00:00:00Z"),
    });
    await expect(fixture.db().execute(sql`UPDATE review_event SET reason = 'x'`)).rejects.toThrow();
    await expect(fixture.db().execute(sql`DELETE FROM review_event`)).rejects.toThrow();
    expect(await repo.list({ limit: 10 })).toHaveLength(1);
  });
});
