import { err, ok, type DomainError, type Result } from "../../domain/shared/result";

const invalid = (): { ok: false; error: DomainError } =>
  err({ kind: "validation", message: "AI output is not valid JSON; approval stopped." });

/**
 * Parses model text as JSON. Tolerates a fenced block and prose around the object. A failure is
 * a `validation` error that never echoes the text.
 */
export function parseJsonText(text: string): Result<unknown, DomainError> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let raw = (fenced?.[1] ?? text).trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) raw = raw.slice(first, last + 1);
  if (!raw) return invalid();
  try {
    return ok(JSON.parse(raw) as unknown);
  } catch {
    return invalid();
  }
}
