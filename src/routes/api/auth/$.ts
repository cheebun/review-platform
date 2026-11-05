import { createFileRoute } from "@tanstack/react-router";
import { getContainer } from "../../../server/runtime";

const handle = async ({ request }: { request: Request }) =>
  (await getContainer()).ports.auth.handler(request);

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
