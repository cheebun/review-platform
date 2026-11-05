import { wakeUpContract } from "../../testing/contracts/wake-up.contract";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { realTimeHarness, useRedisTestEnv } from "../../testing/integration/redis-harness";
import { RedisWakeUp } from "./redis-wake-up";

const env = useRedisTestEnv(import.meta.filename);

wakeUpContract(() => realTimeHarness(new RedisWakeUp(env.fresh(), new MemoryLogger())));
