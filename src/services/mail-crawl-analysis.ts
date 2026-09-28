import type Database from "better-sqlite3";
import type { MailMessage } from "@ludiars/mail-inbox";
import type { MailMessagesRepo } from "../db/mail-messages-repo.js";
import { MailAnalysisRepo } from "../db/mail-analysis-repo.js";
import { classifyMail, type MailRule } from "../mail/classify.js";
import { ignoreFeatures } from "../mail/ignore-features.js";
import type { MailIgnoreEngine } from "./mail-ignore-engine.js";
import { MailAnalysisSchema, type MailAnalyzer } from "./mail-luna-analysis.js";

/** @implements SPEC-MAIL-LUNA-002 SPEC-MAIL-LUNA-003 */
export class MailCrawlAnalysis {
  private readonly cache: MailAnalysisRepo;
  private readonly pending = new Map<string, Promise<boolean>>();
  constructor(private readonly db: Database.Database, private readonly analyzer: MailAnalyzer,
    private readonly messages: MailMessagesRepo, private readonly engine: MailIgnoreEngine,
    private readonly rules: MailRule[]) { this.cache = new MailAnalysisRepo(db); }
  handle(message: MailMessage): Promise<boolean> {
    const pending = this.pending.get(message.id);
    if (pending) return pending;
    const result = this.run(message).finally(() => { this.pending.delete(message.id); });
    this.pending.set(message.id, result);
    return result;
  }
  private async run(message: MailMessage): Promise<boolean> {
    if (this.messages.find(message.id)) return true;
    if (classifyMail(message, this.rules).kind !== "ignore" || this.engine.match(message, false)) return false;
    const cached = this.cache.get(message.id);
    const result = MailAnalysisSchema.parse(cached ?? await this.analyzer.analyze(message));
    if (!cached) this.cache.save(message.id, result);
    const completeInput = (message.text || (message.html ?? "").replace(/<[^>]*>/g, " ")).length <= 24_000;
    const canIgnore = completeInput && result.kind === "ignore" && result.confidence >= 0.95 && ignoreFeatures(message) !== null;
    this.db.transaction(() => {
      const claimed = this.messages.claim({ message_id: message.id, thread_id: message.threadId,
        received_at: Math.floor(message.date.getTime() / 1000), processed_at: Math.floor(Date.now() / 1000),
        from_address: message.from.address, subject: message.subject.replace(/https?:\/\/\S+/gi, "[URL omitted]"),
        kind: "ignore", rule_index: null, error: null,
        outcome: canIgnore ? "ignored: luna" : `analysis_review: ${result.kind}` });
      if (claimed && canIgnore) this.engine.observe(message, true);
    })();
    return true;
  }
}
