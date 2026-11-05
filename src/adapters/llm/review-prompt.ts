import type { ReviewInput } from "../../ports/reviewer";
import { UNTRUSTED_SYSTEM_SENTENCE, wrapUntrusted } from "./untrusted";

/** `tool`: the model answers with a forced function call (OpenAI). `structured`: JSON output. */
export type ReviewPromptMode = "tool" | "structured";

/** The only system text. PR content is delimited in the user message and declared data here. */
export const REVIEW_SYSTEM_PROMPT = UNTRUSTED_SYSTEM_SENTENCE;

const TOOL_LINE =
  "Call the submit_pr_review tool with your result. Do not write a free-form JSON markdown block.";
const STRUCTURED_LINE =
  "Respond with your result as a single JSON object that matches the required output schema. Do not wrap it in a markdown block.";

/**
 * The review prompt. Identical to the pre-migration text except that the PR title, description
 * and diff are wrapped in `<untrusted_pr_content>` blocks, and, in `structured` mode, the one
 * line that asked for a tool call (there is no tool then). See `review-prompt.test.ts`.
 */
export function buildReviewPrompt(input: ReviewInput, mode: ReviewPromptMode): string {
  return `You are conducting a strict, developer-level frontend PR review.

${mode === "tool" ? TOOL_LINE : STRUCTURED_LINE}

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
Title: ${wrapUntrusted(input.title, { inline: true })}
Author: ${input.author}
Base: ${input.base} <- Head: ${input.head}

Description:
${wrapUntrusted(input.body || "(empty)")}

Diff:
${wrapUntrusted(input.diffText)}`;
}
