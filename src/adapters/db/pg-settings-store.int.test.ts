import { settingsStoreContract } from "../../testing/contracts/settings-store.contract";
import { pgSchemaFixture } from "../../testing/integration/pg-fixture";
import { createSecretCiphers } from "../crypto/aes-gcm-token-cipher";
import { PgReviewEventRepo } from "./pg-review-event-repo";
import { PgSettingsStore } from "./pg-settings-store";

// Fake secrets: test vectors only.
const SECRET = "test-secret-0123456789abcdefghijklmnop";
const ROTATED = "rotated-secret-0123456789abcdefghijkl";

// Remote PostgreSQL with a real pool: concurrent saves and channel replacements reach the
// server in parallel here, so the row lock and the table lock are really exercised.
const fixture = pgSchemaFixture(import.meta.url);

settingsStoreContract(async () => ({
  impl: new PgSettingsStore(fixture.db(), createSecretCiphers({ secret: SECRET })),
  events: new PgReviewEventRepo(fixture.db()),
  rotated: () => new PgSettingsStore(fixture.db(), createSecretCiphers({ secret: ROTATED })),
  advance: async () => {},
  cleanup: async () => {},
}));
