import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AiReviewResult, Finding, Severity } from "./types";

const SEVERITY_ORDER: Severity[] = ["P0", "P1", "P2", "Nit"];

const SUBMIT_REVIEW_NAME = "submit_pr_review";
const SUBMIT_REVIEW_DESCRIPTION =
  "Submit the structured PR review result. English fields go to GitHub; Chinese fields are for the local UI.";

const REVIEW_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: {
      type: "string",
      description: "1-3 sentences in English: what changed and main risk areas.",
    },
    summaryZh: {
      type: "string",
      description: "Simplified Chinese version of summary.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["P0", "P1", "P2", "Nit"],
          },
          title: { type: "string", description: "Short English title" },
          titleZh: { type: "string", description: "Chinese short title" },
          body: {
            type: "string",
            description: "English what/why/fix. Single string; use \\n if needed.",
          },
          bodyZh: {
            type: "string",
            description: "Simplified Chinese body with what/why/fix.",
          },
          path: { type: "string", description: "Optional file path" },
          line: { type: "number", description: "Optional line number" },
        },
        required: ["severity", "title", "titleZh", "body", "bodyZh"],
        additionalProperties: false,
      },
    },
    verificationRequests: {
      type: "array",
      items: { type: "string" },
      description: "English verification items (1-3+).",
    },
    verificationRequestsZh: {
      type: "array",
      items: { type: "string" },
      description: "Simplified Chinese verification items.",
    },
  },
  required: ["summary", "summaryZh", "findings", "verificationRequests", "verificationRequestsZh"],
  additionalProperties: false,
};

const SUBMIT_REVIEW_TOOL: Anthropic.Tool = {
  name: SUBMIT_REVIEW_NAME,
  description: SUBMIT_REVIEW_DESCRIPTION,
  input_schema: REVIEW_SCHEMA,
};

const OPENAI_REVIEW_TOOL: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: SUBMIT_REVIEW_NAME,
  description: SUBMIT_REVIEW_DESCRIPTION,
  parameters: REVIEW_SCHEMA,
  // Strict mode would require every optional field (path / line) to be listed as required.
  strict: false,
};

function getClient() {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;

  if (authToken) {
    // Gateway / proxy style: Bearer token + optional custom base URL
    return new Anthropic({
      authToken,
      apiKey: null,
      baseURL,
    });
  }

  if (apiKey) {
    return new Anthropic({
      apiKey,
      baseURL,
    });
  }

  throw new Error(
    "缺少 Anthropic 凭证。请在 .env.local 配置 ANTHROPIC_AUTH_TOKEN（+ ANTHROPIC_BASE_URL）或 ANTHROPIC_API_KEY。",
  );
}

/** Best-effort parse when the model returns fenced/raw JSON instead of tool use. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let raw = (fenced?.[1] ?? text).trim();
  // Strip trailing prose after the JSON object.
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    raw = raw.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Repair unescaped newlines / tabs inside strings (common model failure).
    let inString = false;
    let escaped = false;
    let fixed = "";
    for (const ch of raw) {
      if (escaped) {
        fixed += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        fixed += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        fixed += ch;
        continue;
      }
      if (inString && ch === "\n") {
        fixed += "\\n";
        continue;
      }
      if (inString && ch === "\r") {
        continue;
      }
      if (inString && ch === "\t") {
        fixed += "\\t";
        continue;
      }
      fixed += ch;
    }
    return JSON.parse(fixed);
  }
}

function normalizeSeverity(raw: unknown): Severity | null {
  const value = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (value === "P0" || value === "P1" || value === "P2") return value;
  if (value === "NIT") return "Nit";
  return null;
}

function normalizeFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const severity = normalizeSeverity(item.severity);
  if (!severity) return null;
  if (typeof item.title !== "string" || typeof item.body !== "string") return null;
  const title = item.title.trim();
  const body = item.body.trim();
  if (!title || !body) return null;
  const finding: Finding = { severity, title, body };
  const titleZh = String(item.titleZh ?? "").trim();
  const bodyZh = String(item.bodyZh ?? "").trim();
  if (titleZh) finding.titleZh = titleZh;
  if (bodyZh) finding.bodyZh = bodyZh;
  if (typeof item.path === "string" && item.path.trim()) {
    finding.path = item.path.trim();
  }
  if (typeof item.line === "number" && Number.isFinite(item.line)) {
    finding.line = item.line;
  }
  return finding;
}

function normalizeVerificationRequests(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0);
}

export function toAiReviewResult(parsed: unknown): AiReviewResult {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI 返回的结构无效");
  }

  const obj = parsed as Record<string, unknown>;
  let rawFindings = obj.findings;
  // Some gateways serialize the nested array as JSON inside the tool input.
  if (typeof rawFindings === "string") {
    try {
      rawFindings = JSON.parse(rawFindings);
    } catch {
      throw new Error("AI 返回的 findings 字符串无法解析为 JSON 数组，已停止批准。");
    }
  }
  if (typeof obj.summary !== "string" || !obj.summary.trim() || !Array.isArray(rawFindings)) {
    throw new Error("AI 返回缺少有效 summary / findings，已停止批准。");
  }
  const findings = rawFindings.map(normalizeFinding);
  if (findings.some((finding) => finding === null)) {
    throw new Error("AI 返回的问题结构不完整，已停止批准。");
  }
  const verificationRequests = normalizeVerificationRequests(obj.verificationRequests);
  const verificationRequestsZh = normalizeVerificationRequests(obj.verificationRequestsZh);
  const summary = String(obj.summary ?? "").trim() || "No summary provided.";
  const summaryZh = String(obj.summaryZh ?? "").trim();

  return {
    summary,
    summaryZh: summaryZh || undefined,
    findings: findings as Finding[],
    verificationRequests:
      verificationRequests.length > 0
        ? verificationRequests
        : [
            "Verify the changed critical user paths still work as expected.",
            "Confirm TypeScript / lint / relevant checks pass.",
          ],
    verificationRequestsZh:
      verificationRequestsZh.length > 0
        ? verificationRequestsZh
        : ["验证改动涉及的关键用户路径仍可正常使用。", "确认 TypeScript / lint / 相关检查通过。"],
  };
}

function extractToolInput(content: Anthropic.Message["content"]): unknown | null {
  for (const block of content) {
    if (block.type === "tool_use" && block.name === SUBMIT_REVIEW_NAME) {
      return block.input;
    }
  }
  return null;
}

type ReviewInput = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  diffText: string;
};

function hasAnthropicCredentials() {
  return Boolean(process.env.ANTHROPIC_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_API_KEY?.trim());
}

/** Claude when Anthropic credentials exist; otherwise the OpenAI Responses relay. */
export async function runAiReview(input: ReviewInput): Promise<AiReviewResult> {
  const prompt = buildReviewPrompt(input);
  if (hasAnthropicCredentials()) return runAnthropicReview(prompt);
  if (process.env.OPENAI_API_KEY?.trim()) return runOpenAiReview(prompt);
  throw new Error(
    "缺少 Anthropic 凭证。请在 .env.local 配置 ANTHROPIC_AUTH_TOKEN（+ ANTHROPIC_BASE_URL）或 ANTHROPIC_API_KEY。",
  );
}

async function runOpenAiReview(prompt: string): Promise<AiReviewResult> {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!.trim(),
    // Relay / proxy, e.g. https://relay.example.com/v1; must support the Responses API.
    baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
  });
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL?.trim() || "gpt-6.1-sol",
    reasoning: {
      effort: (process.env.OPENAI_REASONING_EFFORT?.trim() || "medium") as OpenAI.ReasoningEffort,
    },
    // Reasoning tokens count toward this limit.
    max_output_tokens: 32_000,
    tools: [OPENAI_REVIEW_TOOL],
    tool_choice: { type: "function", name: SUBMIT_REVIEW_NAME },
    input: prompt,
  });

  if (response.incomplete_details?.reason === "max_output_tokens") {
    throw new Error("AI 返回因长度限制被截断，已停止批准。");
  }
  const call = response.output.find(
    (item) => item.type === "function_call" && item.name === SUBMIT_REVIEW_NAME,
  );
  if (call?.type === "function_call") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      throw new Error(`AI 工具参数无法解析为 JSON：\n${call.arguments.slice(0, 800)}`);
    }
    return toAiReviewResult(parsed);
  }
  return parseTextReview(response.output_text, `status=${response.status}`);
}

async function runAnthropicReview(prompt: string): Promise<AiReviewResult> {
  const client = getClient();
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  for (let attempt = 0; ; attempt++) {
    const message = await client.messages.create({
      model,
      max_tokens: 8192,
      tools: [SUBMIT_REVIEW_TOOL],
      tool_choice: { type: "tool", name: SUBMIT_REVIEW_NAME },
      messages,
    });

    if (message.stop_reason === "max_tokens") {
      throw new Error("AI 返回因长度限制被截断，已停止批准。");
    }

    try {
      const toolInput = extractToolInput(message.content);
      if (toolInput != null) return toAiReviewResult(toolInput);

      // Fallback for gateways that ignore tool_choice and return text JSON.
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      return parseTextReview(text, `stop_reason=${message.stop_reason}`);
    } catch (error) {
      if (attempt > 0) throw error;
      const correction =
        "The review output failed schema validation. Submit the complete review again using submit_pr_review. summary must be a non-empty string. findings must be an actual JSON array of complete finding objects, not a string containing JSON. Escape quotes inside strings correctly. Preserve every finding; do not remove issues to satisfy the schema.";
      messages.push({ role: "assistant", content: message.content });
      const calls = message.content.filter((block) => block.type === "tool_use");
      messages.push({
        role: "user",
        content: calls.length
          ? calls.map((call) => ({
              type: "tool_result" as const,
              tool_use_id: call.id,
              is_error: true,
              content: correction,
            }))
          : correction,
      });
    }
  }
}

function parseTextReview(text: string, detail: string): AiReviewResult {
  if (!text.trim()) {
    throw new Error(`AI 未返回 submit_pr_review 工具结果（${detail}）`);
  }

  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch {
    throw new Error(`AI 返回无法解析为 JSON：\n${text.slice(0, 800)}`);
  }

  return toAiReviewResult(parsed);
}

function buildReviewPrompt(input: ReviewInput) {
  return `You are conducting a strict, developer-level frontend PR review.

Call the submit_pr_review tool with your result. Do not write a free-form JSON markdown block.

Field language:
- summary / title / body / verificationRequests: English (for GitHub)
- summaryZh / titleZh / bodyZh / verificationRequestsZh: Simplified Chinese (for local UI)
- Do NOT include any AI / tool / source attribution

Severity (do not mix levels):
- P0: definite bug / crash / data issue / build failure / obvious regression (blocker)
- P1: high-probability bug / missing edge cases / inconsistent behavior / performance risk
- P2: maintainability / types / structure / insufficient tests
- Nit: naming / copy / minor polish

Always-check when reviewing:
- Commit messages (no Co-Authored-By, agent, AI, or tool attribution)
- Correctness (branches / state / errors / loading / navigation side effects)
- TypeScript (any / missing types / unsafe assertions)
- React (hooks / dependencies / re-renders / client-server boundaries)
- UI/UX (copy / disabled states / modals / navigation)
- Styling (theme / rem / styled components / imports / semantic HTML)
- i18n (keys / naming / dead keys)
Check when relevant: accessibility, performance, tests.

Rules:
- Be strict, specific, and actionable. Prefer fewer high-signal findings.
- Do NOT return only "LGTM" / "Looks good" / "No issues" as the whole review.
- Even with zero findings, summary + summaryZh must describe the change and what was reviewed.
- verificationRequests and verificationRequestsZh are ALWAYS required (at least 1–3 concrete items), even when findings is empty.
- Every finding must include both English and Chinese title/body.
- Keep each string self-contained (avoid raw line breaks inside values when possible).

PR: ${input.owner}/${input.repo}#${input.number}
Title: ${input.title}
Author: ${input.author}
Base: ${input.base} <- Head: ${input.head}

Description:
${input.body || "(empty)"}

Diff:
${input.diffText}`;
}

export function highestSeverity(findings: Finding[]): Severity | null {
  for (const severity of SEVERITY_ORDER) {
    if (findings.some((f) => f.severity === severity)) return severity;
  }
  return null;
}

function formatFindingBullet(finding: Finding): string {
  const loc =
    finding.path != null
      ? ` (\`${finding.path}${finding.line != null ? `:${finding.line}` : ""}\`)`
      : "";
  return `- **${finding.title}**${loc}: ${finding.body}`;
}

function sectionBullets(findings: Finding[], severity: Severity): string[] {
  const items = findings.filter((f) => f.severity === severity);
  if (items.length === 0) return ["- None."];
  return items.map(formatFindingBullet);
}

export function buildReviewCommentBody(review: AiReviewResult): string {
  const lines: string[] = [
    "## Summary",
    "",
    review.summary,
    "",
    "## 🔴 P0 (Blockers)",
    "",
    ...sectionBullets(review.findings, "P0"),
    "",
    "## 🟠 P1 (High)",
    "",
    ...sectionBullets(review.findings, "P1"),
    "",
    "## 🟡 P2 (Medium)",
    "",
    ...sectionBullets(review.findings, "P2"),
    "",
    "## 🔵 Nit",
    "",
    ...sectionBullets(review.findings, "Nit"),
    "",
    "## Verification Requests",
    "",
  ];

  const requests =
    review.verificationRequests.length > 0
      ? review.verificationRequests
      : ["Verify the changed critical user paths still work as expected."];

  requests.forEach((item, index) => {
    lines.push(`${index + 1}. ${item}`);
  });

  return lines.join("\n");
}

export function decideGithubEvent(findings: Finding[]): "APPROVE" | "REQUEST_CHANGES" {
  if (findings.some((f) => f.severity === "P0")) {
    return "REQUEST_CHANGES";
  }
  return "APPROVE";
}
