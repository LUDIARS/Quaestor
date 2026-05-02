import type Database from "better-sqlite3";
import type { ImportRow, SourceKind } from "../shared/types.js";

export interface CreateImportInput {
  source: SourceKind;
  brand?: string | null;
  account?: string | null;
  filename?: string | null;
  metadata?: Record<string, unknown> | null;
}

export class ImportsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateImportInput): number {
    const now = nowSec();
    const r = this.db
      .prepare(
        `INSERT INTO imports (source, brand, account, filename, imported_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.source,
        input.brand ?? null,
        input.account ?? null,
        input.filename ?? null,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );
    return Number(r.lastInsertRowid);
  }

  find(id: number): ImportRow | undefined {
    return this.db.prepare(`SELECT * FROM imports WHERE id = ?`).get(id) as ImportRow | undefined;
  }

  list(limit = 50): ImportRow[] {
    return this.db
      .prepare(`SELECT * FROM imports ORDER BY imported_at DESC LIMIT ?`)
      .all(limit) as ImportRow[];
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
