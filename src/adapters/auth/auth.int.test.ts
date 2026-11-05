import { pgSchemaFixture } from "../../testing/integration/pg-fixture";
import { authFlowSuite } from "./auth-flow.suite";

const fixture = pgSchemaFixture(import.meta.url);

authFlowSuite(() => fixture.db(), { full: true });
