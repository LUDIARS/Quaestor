import type Database from "better-sqlite3";
import type { FeatureMap } from "@ludiars/blackbox";
import type { IgnoreFeatures } from "../mail/ignore-features.js";

/** Durable unique-message evidence, separate from the mail processing history. */
export class MailIgnoreEvidenceRepo {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS mail_ignore_evidence (
      message_id TEXT PRIMARY KEY, policy TEXT NOT NULL, fingerprint TEXT,
      features TEXT, observed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_mail_ignore_fingerprint ON mail_ignore_evidence(fingerprint);`);
  }
  pendingIds(limit: number): string[] {
    return (this.db.prepare(`SELECT m.message_id FROM mail_messages m
      LEFT JOIN mail_ignore_evidence e ON m.message_id = e.message_id
      WHERE m.kind = 'ignore' AND m.outcome LIKE 'ignored%' AND e.message_id IS NULL
      ORDER BY m.received_at DESC, m.message_id DESC LIMIT ?`).all(limit) as { message_id: string }[])
      .map((row) => row.message_id);
  }
  record(messageId: string, policy: string, candidate: IgnoreFeatures | null, at: number): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO mail_ignore_evidence
      (message_id, policy, fingerprint, features, observed_at) VALUES (?, ?, ?, ?, ?)`).run(
      messageId, policy, candidate?.fingerprint ?? null, candidate ? JSON.stringify(candidate.features) : null, at).changes > 0;
  }
  support(fingerprint: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM mail_ignore_evidence WHERE fingerprint = ?")
      .get(fingerprint) as { n: number }).n;
  }
  features(): FeatureMap[] {
    return (this.db.prepare("SELECT features FROM mail_ignore_evidence WHERE features IS NOT NULL").all() as { features: string }[])
      .map((row) => JSON.parse(row.features) as FeatureMap);
  }
  counts(): { observed: number; eligible: number } {
    return this.db.prepare("SELECT COUNT(*) AS observed, COUNT(fingerprint) AS eligible FROM mail_ignore_evidence")
      .get() as { observed: number; eligible: number };
  }
}
