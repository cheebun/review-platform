import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "./-app-shell";
import { requireViewer } from "./-guard";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ location }) => ({ viewer: await requireViewer(location) }),
  component: AuthedLayout,
});

function AuthedLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
