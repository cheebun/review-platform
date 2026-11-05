import { eventDedupeContract } from "../../testing/contracts/event-dedupe.contract";
import {
  realTimeHarness,
  scaleEventDedupe,
  useRedisTestEnv,
} from "../../testing/integration/redis-harness";
import { RedisEventDedupe } from "./redis-event-dedupe";

const env = useRedisTestEnv(import.meta.filename);

eventDedupeContract(() => realTimeHarness(scaleEventDedupe(new RedisEventDedupe(env.fresh()))));
