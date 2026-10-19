export const REDACTED = '[REDACTED]'

// Replaces every known secret value, and its base64 and URL-encoded forms, with REDACTED.
// gitleaks runs on the result afterward to catch secrets we don't hold the value of.
export function scrub(text: string, secrets: string[]): string {
  const forms = secrets
    .filter((s) => s.length >= 8)
    .flatMap((s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64').replace(/=+$/, ''), encodeURIComponent(s)])
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const form of forms) out = out.split(form).join(REDACTED)
  return out
}
