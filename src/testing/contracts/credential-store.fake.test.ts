import { credentialStoreContract } from "./credential-store.contract";
import { InMemoryCredentialStore } from "../fakes/in-memory-credential-store";
import { InMemoryReviewEventRepo } from "../fakes/in-memory-review-event-repo";

credentialStoreContract(async () => {
  const events = new InMemoryReviewEventRepo();
  return {
    impl: new InMemoryCredentialStore(events),
    events,
    advance: async () => {},
    cleanup: async () => {},
  };
});
