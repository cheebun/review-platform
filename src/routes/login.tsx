import { createFileRoute, useRouter } from "@tanstack/react-router";
import { loginWithToken } from "../functions/login-token";
import { twx } from "../ui/twx";
import { requireInitialized, SETUP_HREF } from "./-guard";
import { LoginForm, type LoginClient } from "./-login-form";
import { safeRedirect } from "./-safe-redirect";

const Page = twx("main")(() => "mx-auto flex max-w-sm flex-col gap-6 p-8");
const Heading = twx("h1")(() => "text-2xl font-semibold text-ink");

const client: LoginClient = {
  login: (token) => loginWithToken({ data: { token } }),
};

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: requireInitialized,
  component: LoginPage,
});

function LoginPage() {
  const { redirect: target } = Route.useSearch();
  const router = useRouter();
  return (
    <Page>
      <Heading>Review platform</Heading>
      <LoginForm
        client={client}
        onSuccess={async () => {
          await router.invalidate();
          await router.navigate({ href: safeRedirect(target) });
        }}
        onNotInitialized={() => void router.navigate({ href: SETUP_HREF })}
      />
    </Page>
  );
}
