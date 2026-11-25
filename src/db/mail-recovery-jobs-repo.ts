import type Database from "better-sqlite3";
import type { RecoveryJob } from "../services/mail-recovery-window.js";

/** Single Qs backend owns recovery. Its restart invalidates unfinished attempts. */
export class MailRecoveryJobsRepo {
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS mail_recovery_jobs (request_id TEXT PRIMARY KEY, status_json TEXT NOT NULL)");
    db.prepare(`UPDATE mail_recovery_jobs SET status_json =
      json_set(status_json, '$.phase', 'interrupted', '$.retryAt', NULL)
      WHERE json_extract(status_json, '$.phase') IN ('scanning', 'importing')`).run();
  }

  get(id: string): RecoveryJob | undefined {
    const row = this.db.prepare("SELECT status_json FROM mail_recovery_jobs WHERE request_id=?").get(id) as
      { status_json: string } | undefined;
    return row && JSON.parse(row.status_json) as RecoveryJob;
  }

  providerRetryAt(): number {
    const row = this.db.prepare(`SELECT MAX(json_extract(status_json, '$.retryAt')) AS retryAt
      FROM mail_recovery_jobs WHERE json_extract(status_json, '$.phase')='partial'`).get() as { retryAt: number | null };
    return row.retryAt ?? 0;
  }

  insert(job: RecoveryJob): void {
    this.db.prepare("INSERT INTO mail_recovery_jobs VALUES (?,?)").run(job.request_id, JSON.stringify(job));
  }

  save(job: RecoveryJob): void {
    this.db.prepare("UPDATE mail_recovery_jobs SET status_json=? WHERE request_id=?").run(JSON.stringify(job), job.request_id);
  }
}
