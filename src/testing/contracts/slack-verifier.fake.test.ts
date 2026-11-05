import { FakeSlackVerifier } from "../fakes/fake-slack-verifier";
import { slackVerifierContract } from "./slack-verifier.contract";

slackVerifierContract(async () => {
  const fake = new FakeSlackVerifier();
  return { impl: fake, world: fake, cleanup: async () => {} };
});
