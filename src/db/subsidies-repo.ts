import type Database from "better-sqlite3";

export type SubsidyKind = "subsidy" | "grant" | "loan" | "other";
export type SubsidyStatus = "open" | "upcoming" | "closed";

export interface SubsidyRow {
  id: number;
  name: string;
  agency: string | null;
  kind: SubsidyKind;
  url: string | null;
  summary: string | null;
  target: string | null;
  requirements: string | null;
  max_amount: number | null;
  subsidy_rate: number | null;
  deadline: string | null;
  status: SubsidyStatus;
  notes: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateSubsidyInput {
  name: string;
  agency?: string | null;
  kind?: SubsidyKind;
  url?: string | null;
  summary?: string | null;
  target?: string | null;
  requirements?: string | null;
  max_amount?: number | null;
  subsidy_rate?: number | null;
  deadline?: string | null;
  status?: SubsidyStatus;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

const FIELDS = [
  "name", "agency", "kind", "url", "summary", "target", "requirements",
  "max_amount", "subsidy_rate", "deadline", "status", "notes",
] as const;

export class SubsidiesRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateSubsidyInput): number {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO subsidies
         (name, agency, kind, url, summary, target, requirements, max_amount, subsidy_rate,
          deadline, status, notes, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.agency ?? null,
        input.kind ?? "subsidy",
        input.url ?? null,
        input.summary ?? null,
        input.target ?? null,
        input.requirements ?? null,
        input.max_amount ?? null,
        input.subsidy_rate ?? null,
        input.deadline ?? null,
        input.status ?? "open",
        input.notes ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now,
      );
    return Number(r.lastInsertRowid);
  }

  find(id: number): SubsidyRow | undefined {
    return this.db.prepare(`SELECT * FROM subsidies WHERE id = ?`).get(id) as SubsidyRow | undefined;
  }

  /** 外部ソース (jGrants 等) の id で既存を探す (クロール取込の重複防止) */
  findByExternalId(jgrantsId: string): SubsidyRow | undefined {
    return this.db
      .prepare(`SELECT * FROM subsidies WHERE json_extract(metadata, '$.jgrants_id') = ? LIMIT 1`)
      .get(jgrantsId) as SubsidyRow | undefined;
  }

  list(filter: { status?: SubsidyStatus } = {}): SubsidyRow[] {
    if (filter.status) {
      return this.db
        .prepare(`SELECT * FROM subsidies WHERE status = ? ORDER BY deadline IS NULL, deadline, id`)
        .all(filter.status) as SubsidyRow[];
    }
    return this.db
      .prepare(`SELECT * FROM subsidies ORDER BY status, deadline IS NULL, deadline, id`)
      .all() as SubsidyRow[];
  }

  update(id: number, patch: Partial<CreateSubsidyInput>): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const map = patch as Record<string, unknown>;
    for (const k of FIELDS) {
      if (k in map) { sets.push(`${k} = @${k}`); params[k] = map[k]; }
    }
    if ("metadata" in map) {
      sets.push("metadata = @metadata");
      params.metadata = patch.metadata ? JSON.stringify(patch.metadata) : null;
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = @updated_at");
    params.updated_at = Math.floor(Date.now() / 1000);
    const r = this.db.prepare(`UPDATE subsidies SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return r.changes > 0;
  }

  delete(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM subsidies WHERE id = ?`).run(id);
    return r.changes > 0;
  }
}
