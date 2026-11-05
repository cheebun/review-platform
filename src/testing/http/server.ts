import { setupServer } from "msw/node";

/** Shared msw server. Handlers are added per test with `server.use(...)`. */
export const server = setupServer();
