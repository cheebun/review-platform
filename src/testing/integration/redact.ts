/** Strips connection strings and any given secret values from text before it is printed. */
export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("<redacted>");
  return out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi, "<redacted-url>");
}
