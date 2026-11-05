import { fakeSecretCiphers, InMemorySettingsStore } from "../fakes/in-memory-settings-store";
import { InMemoryReviewEventRepo } from "../fakes/in-memory-review-event-repo";
import { settingsStoreContract } from "./settings-store.contract";

settingsStoreContract(async () => {
  const events = new InMemoryReviewEventRepo();
  const impl = new InMemorySettingsStore(events);
  return {
    impl,
    events,
    rotated: () => impl.withCiphers(fakeSecretCiphers(1)),
    advance: async () => {},
    cleanup: async () => {},
  };
});
