export type ReviewDiffFile = {
  header: string;
  patch: string;
};

export class ReviewDeferredError extends Error {
  constructor() {
    super("审查进度已保存，等待继续执行。");
    this.name = "ReviewDeferredError";
  }
}

/** Send every file together, without character limits, truncation, or splitting. */
export function buildReviewDiff(files: ReviewDiffFile[]): string {
  return files.map(({ header, patch }) => `${header}\n\`\`\`diff\n${patch}\n\`\`\`\n`).join("\n");
}
