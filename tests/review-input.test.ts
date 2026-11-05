import assert from "node:assert/strict";
import { test } from "vitest";
import { buildReviewDiff } from "../src/lib/review-input";

test("large PRs send all files together without a character cap", () => {
  const files = Array.from({ length: 6 }, (_, index) => ({
    header: `### src/file${index}.ts (added, +1/-0)`,
    patch: `@@ -0,0 +1 @@\n+file${index}:${"x".repeat(250_000)}`,
  }));
  const diff = buildReviewDiff(files);
  assert.ok(diff.length > 1_000_000);
  for (const file of files)
    assert.ok(diff.includes(`${file.header}\n\`\`\`diff\n${file.patch}\n\`\`\`\n`));
});

test("long lines and Unicode remain intact in the complete Diff", () => {
  const patch = `@@ -0,0 +1 @@\n+${"🎉".repeat(200_000)}\n+last-line`;
  assert.equal(
    buildReviewDiff([{ header: "### src/large.ts", patch }]),
    `### src/large.ts\n\`\`\`diff\n${patch}\n\`\`\`\n`,
  );
  assert.equal(buildReviewDiff([]), "");
});
