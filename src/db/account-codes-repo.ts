import type Database from "better-sqlite3";
import { SEED_ACCOUNTS, type AccountKind } from "./seed.js";

export interface AccountCodeRow {
  code: number;
  name: string;
  kind: AccountKind;
  created_at: number;
}

export class AccountCodesRepo {
  constructor(private readonly db: Database.Database) {}

  list(): AccountCodeRow[] {
    return this.db.prepare(`SELECT * FROM account_codes ORDER BY code ASC`).all() as AccountCodeRow[];
  }

  find(code: number): AccountCodeRow | undefined {
    return this.db.prepare(`SELECT * FROM account_codes WHERE code = ?`).get(code) as AccountCodeRow | undefined;
  }

  upsert(row: { code: number; name: string; kind: AccountKind }): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO account_codes (code, name, kind, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET name = excluded.name, kind = excluded.kind`,
      )
      .run(row.code, row.name, row.kind, now);
  }

  /** account_codes が空のとき seed する。 既に何か入っていたら no-op (ユーザのカスタマイズを尊重) */
  seedIfEmpty(): boolean {
    const c = this.db.prepare(`SELECT COUNT(*) AS c FROM account_codes`).get() as { c: number };
    if (c.c > 0) return false;
    const stmt = this.db.prepare(
      `INSERT INTO account_codes (code, name, kind, created_at) VALUES (?, ?, ?, ?)`,
    );
    const now = Math.floor(Date.now() / 1000);
    this.db.transaction(() => {
      for (const a of SEED_ACCOUNTS) stmt.run(a.code, a.name, a.kind, now);
    })();
    return true;
  }
}
