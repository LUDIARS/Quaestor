import type Database from "better-sqlite3";

/** @implements SPEC-MAIL-LUNA-002 */
export class MailAnalysisRepo {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS mail_luna_analysis (
      message_id TEXT PRIMARY KEY, result TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  }
  get(id: string): unknown {
    const row = this.db.prepare("SELECT result FROM mail_luna_analysis WHERE message_id=?").get(id) as { result: string } | undefined;
    return row ? JSON.parse(row.result) as unknown : undefined;
  }
  save(id: string, result: { kind: string; confidence: number }): void {
    this.db.prepare("INSERT OR IGNORE INTO mail_luna_analysis VALUES (?,?,?,?)")
      .run(id, JSON.stringify(result), "gpt-6-luna", Math.floor(Date.now() / 1000));
  }
}
