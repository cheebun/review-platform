import { settingsRepoContract } from "./settings-repo.contract";
import { InMemorySettingsRepo } from "../fakes/in-memory-settings-repo";
import { InMemoryReviewEventRepo } from "../fakes/in-memory-review-event-repo";

settingsRepoContract(async () => {
  const events = new InMemoryReviewEventRepo();
  return {
    impl: new InMemorySettingsRepo(events),
    events,
    advance: async () => {},
    cleanup: async () => {},
  };
});
