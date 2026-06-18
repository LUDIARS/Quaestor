/**
 * 事業計画の永続化 (plans / sections / figures / reviews)。
 * 作成時に template 定義から sections / figures の空行を seed する。
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getTemplate, expandPeriods, type PlanPurpose } from "../business-plan/templates.js";

export type PlanStatus = "draft" | "review" | "final";
export type ReviewKind = "quantitative" | "qualitative" | "combined";

export interface PlanRow {
  id: string;
  name: string;
  template: string;
  purpose: PlanPurpose;
  status: PlanStatus;
  fiscal_start: string | null;
  horizon_years: number;
  notes: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export interface SectionRow {
  id: number;
  plan_id: string;
  key: string;
  body: string;
  display_order: number;
  updated_at: number;
}

export interface FigureRow {
  id: number;
  plan_id: string;
  category: string;
  label: string;
  period: string;
  amount: number | null;
  display_order: number;
  source: "manual" | "from_actuals";
  metadata: string | null;
}

export interface ReviewRow {
  id: number;
  plan_id: string;
  kind: ReviewKind;
  score: number | null;
  summary: string | null;
  findings: string;
  metrics: string | null;
  model: string | null;
  created_at: number;
}

export interface CreatePlanInput {
  name: string;
  template: string;
  purpose?: PlanPurpose;
  fiscal_start?: string | null;
  horizon_years?: number;
  notes?: string | null;
}

export interface FigureUpsert {
  category: string;
  label: string;
  period: string;
  amount: number | null;
  display_order?: number;
  source?: "manual" | "from_actuals";
  metadata?: Record<string, unknown> | null;
}

export class BusinessPlansRepo {
  constructor(private readonly db: Database.Database) {}

  /** template から sections/figures を seed しつつ plan を作成。 plan id を返す */
  create(input: CreatePlanInput): string {
    const tpl = getTemplate(input.template);
    if (!tpl) throw new Error(`unknown template: ${input.template}`);
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const horizon = input.horizon_years ?? tpl.horizonYears;

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO business_plans
           (id, name, template, purpose, status, fiscal_start, horizon_years, notes, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, input.name, tpl.id, input.purpose ?? tpl.purpose, input.fiscal_start ?? null, horizon, input.notes ?? null, now, now);

      const insSection = this.db.prepare(
        `INSERT INTO business_plan_sections (plan_id, key, body, display_order, updated_at) VALUES (?, ?, '', ?, ?)`,
      );
      tpl.sections.forEach((s, i) => insSection.run(id, s.key, i, now));

      const insFigure = this.db.prepare(
        `INSERT INTO business_plan_figures (plan_id, category, label, period, amount, display_order, source, metadata)
         VALUES (?, ?, ?, ?, NULL, ?, 'manual', ?)`,
      );
      let order = 0;
      for (const spec of tpl.figures) {
        const meta = spec.tag ? JSON.stringify({ tag: spec.tag }) : null;
        for (const period of expandPeriods(spec.periods, horizon)) {
          insFigure.run(id, spec.category, spec.label, period, order, meta);
        }
        order++;
      }
    })();

    return id;
  }

  list(): PlanRow[] {
    return this.db.prepare(`SELECT * FROM business_plans ORDER BY updated_at DESC`).all() as PlanRow[];
  }

  find(id: string): PlanRow | undefined {
    return this.db.prepare(`SELECT * FROM business_plans WHERE id = ?`).get(id) as PlanRow | undefined;
  }

  sections(planId: string): SectionRow[] {
    return this.db
      .prepare(`SELECT * FROM business_plan_sections WHERE plan_id = ? ORDER BY display_order, id`)
      .all(planId) as SectionRow[];
  }

  figures(planId: string): FigureRow[] {
    return this.db
      .prepare(`SELECT * FROM business_plan_figures WHERE plan_id = ? ORDER BY display_order, category, period`)
      .all(planId) as FigureRow[];
  }

  reviews(planId: string): ReviewRow[] {
    return this.db
      .prepare(`SELECT * FROM business_plan_reviews WHERE plan_id = ? ORDER BY created_at DESC, id DESC`)
      .all(planId) as ReviewRow[];
  }

  latestReview(planId: string): ReviewRow | undefined {
    return this.db
      .prepare(`SELECT * FROM business_plan_reviews WHERE plan_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(planId) as ReviewRow | undefined;
  }

  updateMeta(id: string, patch: Partial<Pick<PlanRow, "name" | "purpose" | "status" | "fiscal_start" | "horizon_years" | "notes">>): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const k of ["name", "purpose", "status", "fiscal_start", "horizon_years", "notes"] as const) {
      if (k in patch) { sets.push(`${k} = @${k}`); params[k] = patch[k]; }
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = @updated_at");
    params.updated_at = Math.floor(Date.now() / 1000);
    const r = this.db.prepare(`UPDATE business_plans SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return r.changes > 0;
  }

  delete(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM business_plans WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  /** セクション本文を upsert (新規 key も許容)。 plan の updated_at も更新 */
  upsertSection(planId: string, key: string, body: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.transaction(() => {
      const order = this.db
        .prepare(`SELECT COALESCE(MAX(display_order) + 1, 0) AS n FROM business_plan_sections WHERE plan_id = ?`)
        .get(planId) as { n: number };
      this.db
        .prepare(
          `INSERT INTO business_plan_sections (plan_id, key, body, display_order, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(plan_id, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
        )
        .run(planId, key, body, order.n, now);
      this.touch(planId, now);
    })();
  }

  /** 数字を bulk upsert。 plan の updated_at も更新 */
  upsertFigures(planId: string, figures: FigureUpsert[]): number {
    const now = Math.floor(Date.now() / 1000);
    let count = 0;
    this.db.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT INTO business_plan_figures (plan_id, category, label, period, amount, display_order, source, metadata)
         VALUES (@plan_id, @category, @label, @period, @amount, @display_order, @source, @metadata)
         ON CONFLICT(plan_id, category, label, period) DO UPDATE SET
           amount = excluded.amount, source = excluded.source, metadata = excluded.metadata`,
      );
      for (const f of figures) {
        stmt.run({
          plan_id: planId,
          category: f.category,
          label: f.label,
          period: f.period,
          amount: f.amount,
          display_order: f.display_order ?? 0,
          source: f.source ?? "manual",
          metadata: f.metadata ? JSON.stringify(f.metadata) : null,
        });
        count++;
      }
      this.touch(planId, now);
    })();
    return count;
  }

  insertReview(input: {
    plan_id: string;
    kind: ReviewKind;
    score: number | null;
    summary: string | null;
    findings: unknown;
    metrics?: unknown;
    model?: string | null;
  }): number {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO business_plan_reviews (plan_id, kind, score, summary, findings, metrics, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.plan_id,
        input.kind,
        input.score,
        input.summary,
        JSON.stringify(input.findings ?? []),
        input.metrics !== undefined ? JSON.stringify(input.metrics) : null,
        input.model ?? null,
        now,
      );
    return Number(r.lastInsertRowid);
  }

  private touch(planId: string, now: number): void {
    this.db.prepare(`UPDATE business_plans SET updated_at = ? WHERE id = ?`).run(now, planId);
  }
}
