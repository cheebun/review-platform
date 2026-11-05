import { useQuery } from "@tanstack/react-query";
import { settingsQueryOptions } from "../../../queries/settings";
import { FnRequestError } from "../../../queries/fn-result";
import { Alert, Button, Skeleton, twx } from "../../../ui";
import { RepoSection } from "./repo-section";
import { TokenSection } from "./token-section";

const Section = twx("section")(() => "flex flex-col gap-4");
const SectionTitle = twx("h2")(() => "text-headline-md text-heading");

/** /settings, GitHub: the token and the repo list. Also step 3 of /setup. */
export function GithubSection() {
  const query = useQuery(settingsQueryOptions());

  return query.isPending ? (
    <Skeleton lines={4} aria-label="正在加载设置" />
  ) : query.isError ? (
    <Alert
      tone="danger"
      title="设置加载失败"
      action={
        <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
          重试
        </Button>
      }
    >
      请稍后重试
      {query.error instanceof FnRequestError ? `（请求 ID：${query.error.requestId}）` : ""}。
    </Alert>
  ) : (
    <Section aria-labelledby="settings-github">
      <SectionTitle id="settings-github">GitHub</SectionTitle>
      <TokenSection view={query.data} />
      <RepoSection view={query.data} />
    </Section>
  );
}
