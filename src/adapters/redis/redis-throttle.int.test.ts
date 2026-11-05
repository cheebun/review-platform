import { throttleContract } from "../../testing/contracts/throttle.contract";
import {
  realTimeHarness,
  scaleThrottle,
  useRedisTestEnv,
} from "../../testing/integration/redis-harness";
import { RedisThrottle } from "./redis-throttle";

const env = useRedisTestEnv(import.meta.filename);

throttleContract(() => realTimeHarness(scaleThrottle(new RedisThrottle(env.fresh()))));
