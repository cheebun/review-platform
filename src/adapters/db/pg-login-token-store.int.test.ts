import { loginTokenStoreContract } from "../../testing/contracts/login-token-store.contract";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { pgSchemaFixture } from "../../testing/integration/pg-fixture";
import { PgLoginTokenStore } from "./pg-login-token-store";

// Remote PostgreSQL with a real pool: concurrent initializes reach the server in parallel here,
// so `ON CONFLICT (id) DO NOTHING` is really the single-writer guarantee under test.
const fixture = pgSchemaFixture(import.meta.url);

loginTokenStoreContract(async () => ({
  impl: new PgLoginTokenStore(fixture.db(), new FakeClock()),
  advance: async () => {},
  cleanup: async () => {},
}));
