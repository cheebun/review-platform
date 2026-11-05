import { FakeGitHub } from "../fakes/fake-github";
import { githubContract } from "./github.contract";

githubContract(async () => {
  const impl = new FakeGitHub();
  return { impl, world: impl.world, advance: async () => {}, cleanup: async () => {} };
});
