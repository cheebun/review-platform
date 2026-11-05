import { scrubCredentialEnv } from "../credential-env";

// Runs before every test file in every vitest project: Jira and LLM credentials never come from
// env in tests. Tests that need them seed the settings-store fake (src/testing/settings-seed.ts).
scrubCredentialEnv();
