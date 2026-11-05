import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  finishSetup,
  getSetupSections,
  listSetupGithubRepos,
  testSetupAnthropic,
  testSetupSlack,
} from "../functions/setup";
import { guardSetup } from "./-guard";
import type { SetupClient } from "./-setup/setup-client";
import { SetupWizard } from "./-setup/setup-wizard";

const client: SetupClient = {
  sections: () => getSetupSections(),
  testAnthropic: (data) => testSetupAnthropic({ data }),
  listGithubRepos: (token) => listSetupGithubRepos({ data: { token } }),
  testSlack: (userToken) => testSetupSlack({ data: { userToken } }),
  finish: (data) => finishSetup({ data }),
};

export const Route = createFileRoute("/setup")({
  head: () => ({ meta: [{ title: "Setup · Review platform" }] }),
  beforeLoad: ({ location }) => guardSetup(location),
  component: SetupPage,
});

function SetupPage() {
  const router = useRouter();
  return (
    <SetupWizard
      client={client}
      onDone={() => void router.navigate({ href: "/" })}
      toLogin={() => void router.navigate({ href: "/login" })}
    />
  );
}
