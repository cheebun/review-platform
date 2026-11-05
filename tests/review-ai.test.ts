import assert from "node:assert/strict";
import { createServer } from "node:http";
import { onTestFinished, test } from "vitest";
import { runAiReview, toAiReviewResult } from "../src/lib/review-ai";

const finding = { severity: "P0", title: "Crash", body: "Missing guard" };
const review = {
  summary: "Reviewed form validation",
  findings: [finding],
  verificationRequests: ["Test validation"],
};
const input = {
  owner: "example",
  repo: "example",
  number: 1,
  title: "Test",
  body: "",
  author: "author",
  base: "main",
  head: "branch",
  diffText: "+change",
};

test("decodes gateway JSON arrays while preserving blockers and rejecting malformed output", () => {
  assert.deepEqual(toAiReviewResult({ ...review, findings: JSON.stringify([finding]) }).findings, [
    finding,
  ]);
  assert.deepEqual(toAiReviewResult({ ...review, findings: "[]" }).findings, []);
  for (const findings of [
    '[{"severity":"P0","body":"unescaped "quote""}]',
    "null",
    "{}",
    JSON.stringify([{ severity: "P0" }]),
  ]) {
    assert.throws(() => toAiReviewResult({ ...review, findings }));
  }
});

test("asks Claude to correct invalid tool output once and still fails closed", async () => {
  const envKeys = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  onTestFinished(() => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  let outputs: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "test",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "tool_test", name: "submit_pr_review", input: outputs.shift() },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`;

  outputs = [{ ...review, findings: "[invalid JSON]" }, review];
  const result = await runAiReview(input);
  assert.deepEqual(result.findings, [finding]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.length, 3);
  assert.deepEqual(requests[1].messages[1].content, [
    {
      type: "tool_use",
      id: "tool_test",
      name: "submit_pr_review",
      input: { ...review, findings: "[invalid JSON]" },
    },
  ]);
  assert.match(
    JSON.stringify(requests[1].messages[2].content),
    /tool_result.*is_error.*Preserve every finding/,
  );

  requests.length = 0;
  outputs = [{}, {}];
  await assert.rejects(runAiReview(input), /summary \/ findings/);
  assert.equal(requests.length, 2);

  requests.length = 0;
  outputs = [review];
  await runAiReview(input);
  assert.equal(requests.length, 1);
});
