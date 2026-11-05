import { createFileRoute } from "@tanstack/react-router";
import type { Actor } from "../../domain/shared/actor";
import { toHttp } from "../../server/errors";
import { jsonResponse } from "../../server/middleware/auth-middleware";
import { getContainer } from "../../server/runtime";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: async ({ context }) => {
        const actor = (context as { actor?: Actor }).actor;
        if (!actor) {
          // Defence in depth: the global middleware already rejects this case.
          const { ports } = await getContainer();
          return jsonResponse(toHttp({ kind: "unauthenticated" }, ports.ids.uuid()));
        }
        if (actor.kind !== "user") {
          // Only a session reaches here; any other actor kind is not a caller of this API.
          const { ports } = await getContainer();
          return jsonResponse(toHttp({ kind: "unauthenticated" }, ports.ids.uuid()));
        }
        // The kind only: there is one user, and its internal email is not public.
        const body = { actor: { kind: actor.kind } };
        return Response.json(body, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
