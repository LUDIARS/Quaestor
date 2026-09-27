import type { MailSource } from "@ludiars/mail-inbox";
import type { MailMessagesRepo } from "../db/mail-messages-repo.js";
import { classifyMail, type MailRule } from "../mail/classify.js";
import type { MailIgnoreEngine } from "./mail-ignore-engine.js";

/** Backfill features only; never replay financial ingestion, notifications or mail history updates. */
export async function bootstrapIgnorePatterns(source: MailSource, messages: MailMessagesRepo,
  engine: MailIgnoreEngine, rules: MailRule[], limit: number): Promise<{ fetched: number; observed: number; skipped: number; errors: number }> {
  const result = { fetched: 0, observed: 0, skipped: 0, errors: 0 };
  for (const id of engine.pendingIds(limit)) {
    const history = messages.find(id);
    if (!history || history.kind !== "ignore" || !history.outcome.startsWith("ignored")) { result.skipped++; continue; }
    try {
      const message = await source.get(id, { loadAttachments: false });
      result.fetched++;
      if (!message || classifyMail(message, rules).kind !== "ignore") { result.skipped++; continue; }
      engine.observe(message);
      result.observed++;
    } catch {
      // Provider errors can contain personal data. Failed IDs remain unobserved for an explicit retry.
      result.errors++;
    }
  }
  return result;
}
