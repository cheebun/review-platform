import { describe, expect, it } from "vitest";
import { err, ok } from "../../domain/shared/result";
import { FakeReviewer } from "../../testing/fakes/fake-reviewer";

const input = {
  owner: "o",
  repo: "r",
  number: 1,
  title: "t",
  body: "",
  author: "a",
  base: "main",
  head: "h",
  diffText: "+x",
};
const failure = err({ kind: "upstream", service: "llm", retryable: true } as const);

describe("LLM fakes", () => {
  it("FakeReviewer defaults to an approving review, then plays its script and repeats the last", async () => {
    expect((await new FakeReviewer().review(input)).ok).toBe(true);
    const fake = new FakeReviewer(
      failure,
      ok({ summary: "s", findings: [], verificationRequests: [] }),
    );
    expect((await fake.review(input)).ok).toBe(false);
    expect((await fake.review(input)).ok).toBe(true);
    expect((await fake.review(input)).ok).toBe(true);
    expect(fake.calls).toHaveLength(3);
  });
});
