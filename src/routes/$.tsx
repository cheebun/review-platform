import { createFileRoute } from "@tanstack/react-router";
import { isApiPath, notFound, requireViewer } from "./-guard";

// Catch-all for unknown pages. An anonymous caller is redirected to /login first, so they cannot
// probe which pages exist; only a signed-in viewer sees the 404. Unmatched /api/* paths are a
// plain 404 (the access middleware has already decided who may reach them).
export const Route = createFileRoute("/$")({
  beforeLoad: async ({ location }) => {
    if (isApiPath(location.pathname)) throw notFound();
    await requireViewer(location);
    throw notFound();
  },
});
