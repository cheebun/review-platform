import { appStateRepoContract } from "../../testing/contracts/app-state-repo.contract";
import { credentialStoreContract } from "../../testing/contracts/credential-store.contract";
import { reviewEventRepoContract } from "../../testing/contracts/review-event-repo.contract";
import { settingsRepoContract } from "../../testing/contracts/settings-repo.contract";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { pgSchemaFixture } from "../../testing/integration/pg-fixture";
import { PgAppStateRepo } from "./pg-app-state-repo";
import { PgCredentialStore } from "./pg-credential-store";
import { PgReviewEventRepo } from "./pg-review-event-repo";
import { PgSettingsRepo } from "./pg-settings-repo";

const fixture = pgSchemaFixture(import.meta.url);

appStateRepoContract(async () => ({
  impl: new PgAppStateRepo(fixture.db(), new FakeClock()),
  advance: async () => {},
  cleanup: async () => {},
}));

// GitHub settings stores on remote PostgreSQL: real concurrency for the serialisation cases.
// They share this file's fixture so the run opens no extra pool.
const harness = <T>(impl: T) => ({ impl, advance: async () => {}, cleanup: async () => {} });
// The settings stores write `review_event` in their own transaction; `events` reads it back.
const withEvents = <T>(impl: T) => ({
  ...harness(impl),
  events: new PgReviewEventRepo(fixture.db()),
});
credentialStoreContract(async () => withEvents(new PgCredentialStore(fixture.db())));
settingsRepoContract(async () => withEvents(new PgSettingsRepo(fixture.db())));
reviewEventRepoContract(async () => harness(new PgReviewEventRepo(fixture.db())));
