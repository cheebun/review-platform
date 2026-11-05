import { pgliteFixture } from "../db/pglite-fixture";
import { authFlowSuite } from "./auth-flow.suite";

const fixture = pgliteFixture();

authFlowSuite(() => fixture.db(), { full: false });
