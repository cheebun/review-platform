import { loginTokenStoreContract } from "./login-token-store.contract";
import { FakeClock } from "../fakes/fake-clock";
import { InMemoryLoginTokenStore } from "../fakes/in-memory-login-token-store";

loginTokenStoreContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new InMemoryLoginTokenStore(clock),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
