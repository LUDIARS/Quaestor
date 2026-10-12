/** Independent diagnostics-boundary predicate for SPEC-MAIL-CRAWLER-007. */
const ALLOWED = new Set(["stage", "category", "errorClass", "at", "code", "status", "reason"]);
const SAFE = /^[A-Za-z0-9_.-]{1,64}$/;

function expectedCategory(message: string): string | undefined {
  if (message === "OAuth token refresh was rejected") return "gmail_auth_refresh_rejected";
  const http = /^gmail_http_(\d{3})$/.exec(message);
  if (http) return `gmail_${http[1]}`;
  return message === "fetch failed" ? "network" : undefined;
}

export default {
  post(result: unknown, error: unknown): true | string {
    if (result === null || typeof result !== "object") return "Failure must be an object";
    const entries = Object.entries(result as Record<string, unknown>);
    if (entries.some(([key]) => !ALLOWED.has(key))) return "Only classified fields may be returned";
    const message = error instanceof Error ? error.message : "";
    for (const [key, value] of entries) {
      if (value === undefined || typeof value === "number") continue;
      if (typeof value !== "string" || !SAFE.test(value)) return `Field ${key} must be a safe token`;
      if (message.length > 0 && value === message && key !== "category") return `Field ${key} copies the exception message`;
    }
    const expected = expectedCategory(message);
    const category = (result as { category?: unknown }).category;
    return expected === undefined || category === expected || `Expected category ${expected}`;
  },
};
