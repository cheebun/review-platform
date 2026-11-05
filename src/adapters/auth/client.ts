import { createAuthClient } from "better-auth/react";

/** Browser client for `/api/auth/*`. Same origin, so no base URL is configured. */
export const authClient = createAuthClient();
