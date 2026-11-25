import { setTimeout as delay } from "node:timers/promises";
import type { MailMessage } from "@ludiars/mail-inbox";
import type { MailMessagesRepo } from "../db/mail-messages-repo.js";
import type { GmailCrawlSource } from "./gmail-crawl-source.js";
import { GmailRateLimit } from "./gmail-rate-limit.js";

export const WINDOW_START = "2026-10-03T01:00:00.000Z";
export const WINDOW_END = "2026-11-25T01:48:48.000Z";
const start = Date.parse(WINDOW_START);
const end = Date.parse(WINDOW_END);

export type RecoveryOutcome = "imported" | "raced" | "deferred" | "unresolved";
export interface RecoveryRequest {
  request_id: string;
  mode: "dry_run" | "import_missing";
  dry_run_id?: string;
}
export function emptyCounts() {
  return { pages: 0, examined: 0, duplicate: 0, outside: 0, unknownDate: 0,
    terminal: 0, existingError: 0, processing: 0, missing: 0,
    imported: 0, raced: 0, deferred: 0, unresolved: 0, failures: 0 };
}
export interface RecoveryJob extends RecoveryRequest {
  startUtc: string;
  endUtc: string;
  phase: "scanning" | "importing" | "finished" | "partial" | "interrupted";
  exhausted: boolean;
  retryAt: number | null;
  counts: ReturnType<typeof emptyCounts>;
}

export interface RecoveryWindowDeps {
  query: string;
  source: Pick<GmailCrawlSource, "listIds" | "internalDate" | "get" | "loadAttachment">;
  messages: Pick<MailMessagesRepo, "outcome">;
  ingest: (message: MailMessage, load: (id: string, attachment: string) => Promise<Buffer | undefined>) => Promise<RecoveryOutcome>;
}

/** Only opaque IDs for this one scan live in memory. Import starts after validating every page. */
export async function recoverWindow(deps: RecoveryWindowDeps, job: RecoveryJob, signal: AbortSignal,
  checkConnection: () => void, save: () => void): Promise<void> {
  const check = () => { signal.throwIfAborted(); checkConnection(); };
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (;;) {
      check();
      try {
        const value = await operation();
        check();
        return value;
      } catch (error) {
        // Preserve the page and the shared paced source. A local 1-minute budget must
        // not strand a large window forever by restarting it on the first page.
        if (!(error instanceof GmailRateLimit)) throw error;
        job.retryAt = error.retryAt;
        // Only recovery sleeps here, outside the shared Gmail request queue.
        if (error.reason !== "localBudget") throw error;
        save();
        await delay(Math.min(2_147_000_000, Math.max(1, error.retryAt - Date.now())), undefined, { signal });
        job.retryAt = null;
      }
    }
  };
  // While a provider read or cooldown is pending, the ordinary crawler/watch
  // may claim this ID. Check each retry and again before using the returned data.
  const readMissing = async <T>(id: string, operation: () => Promise<T>): Promise<T | undefined> => {
    const value = await read(async () => deps.messages.outcome(id) ? undefined : operation());
    return deps.messages.outcome(id) ? undefined : value;
  };
  const scope = deps.query.trim();
  if (!scope) throw new Error("missing_recovery_query");
  // Gmail after: is a prefilter with second resolution. Keep the lower edge
  // even for strict comparisons, then apply [start,end) using internalDate.
  const query = `(${scope}) after:${start / 1000 - 1} before:${end / 1000}`;
  const pending: string[] = [];
  const seen = new Set<string>();
  const tokens = new Set<string>();
  let token: string | null = null;
  const counts = job.counts;
  do {
    const page = await read(() => deps.source.listIds(query, token, true));
    counts.pages++;
    for (const id of page.ids) {
      if (seen.has(id)) { counts.duplicate++; continue; }
      seen.add(id);
      const ms = await read(() => deps.source.internalDate(id));
      counts.examined++;
      if (ms === null) { counts.unknownDate++; continue; }
      if (ms < start || ms >= end) { counts.outside++; continue; }
      const row = deps.messages.outcome(id);
      if (!row) {
        counts.missing++;
        if (job.mode === "import_missing") pending.push(id);
      } else if (row.outcome === "processing") counts.processing++;
      else if (row.outcome === "error" || row.error !== null) counts.existingError++;
      else counts.terminal++;
    }
    token = page.nextPageToken;
    if (token && tokens.has(token)) throw new Error("gmail_repeated_page");
    if (token) tokens.add(token);
    save();
  } while (token);
  job.exhausted = true;
  if (counts.unknownDate) { job.phase = "partial"; return; }
  if (job.mode === "import_missing") {
    job.phase = "importing";
    save();
    for (const id of pending) {
      check();
      const message = await readMissing(id, () => deps.source.get(id, { loadAttachments: false }));
      if (message === undefined) { counts.raced++; continue; }
      const ms = message?.date.getTime();
      if (!message || message.id !== id || ms === undefined || !Number.isSafeInteger(ms) || ms < start || ms >= end) {
        counts.unresolved++;
      } else {
        const outcome = await deps.ingest(message, (messageId, attachment) =>
          readMissing(messageId, () => deps.source.loadAttachment(messageId, attachment)));
        counts[outcome]++;
      }
      save();
    }
  }
  // Finished describes the scan. Only 'imported' counts successful new intake.
  job.phase = counts.unresolved ? "partial" : "finished";
}
