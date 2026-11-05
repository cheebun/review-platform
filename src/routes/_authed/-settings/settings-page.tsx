import { twx } from "../../../ui";
import { GithubSection } from "./github-section";
import { LlmSection } from "./llm/llm-section";
import { LoginTokenSection } from "./login-token-section";
import { SlackSection } from "./slack/slack-section";

const Page = twx("div")(() => "flex flex-col gap-6");
const Intro = twx("div")(() => "flex flex-col gap-1");
const Title = twx("h1")(() => "text-headline-lg text-heading");
const Description = twx("p")(() => "max-w-3xl text-body-md text-secondary-text");

/**
 * /settings: the page intro followed by GitHub, Slack, Anthropic and the login token.
 * Each section loads on its own and never shows a secret.
 */
export function SettingsPage() {
  return (
    <Page>
      <Intro>
        <Title>Settings</Title>
        <Description>
          GitHub、Slack 与 LLM 连接。Token 和密钥加密保存，页面只显示状态和末四位。
        </Description>
      </Intro>

      <GithubSection />
      <SlackSection />
      <LlmSection />
      <LoginTokenSection />
    </Page>
  );
}
