import { FakeSlack } from "../../fakes/fake-slack";
import { slackContract } from "./slack.contract";

slackContract(async () => {
  const fake = new FakeSlack();
  return { impl: fake, world: fake, cleanup: async () => {} };
});
