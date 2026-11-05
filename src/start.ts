import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { accessMiddleware, publicServerFnGate } from "./server/middleware/auth-middleware";

// Server functions are cookie-authenticated RPC, so cross-site calls are refused. API routes are
// not covered: better-auth checks origins itself and machine callers send no cookies.
const csrfMiddleware = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, accessMiddleware],
  // Runs first for every server function: only setup and login are callable without a session.
  functionMiddleware: [publicServerFnGate],
}));
