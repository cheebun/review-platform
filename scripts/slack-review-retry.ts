import { retryFailedSlackReviewJobs } from "../src/lib/slack-review-queue";
import { createSlackReviewRedisQueue } from "../src/lib/slack-review-redis";
import { loadLocalEnv } from "../src/server/local-env";

loadLocalEnv({ cwd: process.cwd() });

retryFailedSlackReviewJobs(createSlackReviewRedisQueue())
  .then((count) => {
    console.log(
      `[slack-review] 已重新排队 ${count} 个失败任务；打开 /review 页面或等新消息到达后会继续执行。`,
    );
  })
  .catch((error: unknown) => {
    console.error("[slack-review]", error instanceof Error ? error.message : "重试失败");
    process.exitCode = 1;
  });
