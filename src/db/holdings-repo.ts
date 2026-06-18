/**
 * holdings — 保有/積立投資商品の repo。
 * 投信(fund) / 個別株(stock) / ETF(etf) / 保険型(insurance) を 1 テーブルに合流して扱う。
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type HoldingKind = "fund" | "stock" | "etf" | "insurance" | "other";
export type HoldingStatus = "active" | "paused" | "closed";
export type TaxWrapper =
  | "nisa_tsumitate"
  | "nisa_growth"
  | "ideco"
  | "taxable"
  | "insurance";

export interface HoldingRow {
  id: string;
  kind: HoldingKind;
  name: string;
  account: string | null;
  ticker: string | null;
  fund_code: string | null;
  currency: string;
  tax_wrapper: TaxWrapper | null;
  target_amount: number | null;
  monthly_contribution: number | null;
  status: HoldingStatus;
  started_at: string | null;
  notes: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateHoldingInput {
  kind: HoldingKind;
  name: string;
  account?: string | null;
  ticker?: string | null;
  fund_code?: string | null;
  currency?: string;
  tax_wrapper?: TaxWrapper | null;
  target_amount?: number | null;
  monthly_contribution?: number | null;
  status?: HoldingStatus;
  started_at?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** create で省略可能なフィールドのみ更新対象にする (部分更新)。 */
export type UpdateHoldingInput = Partial<CreateHoldingInput>;

const UPDATABLE: (keyof CreateHoldingInput)[] = [
  "kind", "name", "account", "ticker", "fund_code", "currency",
  "tax_wrapper", "target_amount", "monthly_contribution", "status",
  "started_at", "notes",
];

export class HoldingsRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateHoldingInput): HoldingRow {
    const now = nowSec();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO holdings
           (id, kind, name, account, ticker, fund_code, currency, tax_wrapper,
            target_amount, monthly_contribution, status, started_at, notes, metadata,
            created_at, updated_at)
         VALUES
           (@id, @kind, @name, @account, @ticker, @fund_code, @currency, @tax_wrapper,
            @target_amount, @monthly_contribution, @status, @started_at, @notes, @metadata,
            @now, @now)`,
      )
      .run({
        id,
        kind: input.kind,
        name: input.name,
        account: input.account ?? null,
        ticker: input.ticker ?? null,
        fund_code: input.fund_code ?? null,
        currency: input.currency ?? "JPY",
        tax_wrapper: input.tax_wrapper ?? null,
        target_amount: input.target_amount ?? null,
        monthly_contribution: input.monthly_contribution ?? null,
        status: input.status ?? "active",
        started_at: input.started_at ?? null,
        notes: input.notes ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        now,
      });
    return this.find(id)!;
  }

  /** 部分更新。 渡されたキーのみ SET する。 metadata は JSON 化。 */
  update(id: string, patch: UpdateHoldingInput): HoldingRow | undefined {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: nowSec() };
    for (const key of UPDATABLE) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = @${key}`);
        params[key] = patch[key];
      }
    }
    if (patch.metadata !== undefined) {
      sets.push("metadata = @metadata");
      params.metadata = patch.metadata ? JSON.stringify(patch.metadata) : null;
    }
    if (sets.length === 0) return this.find(id);
    sets.push("updated_at = @now");
    this.db.prepare(`UPDATE holdings SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return this.find(id);
  }

  find(id: string): HoldingRow | undefined {
    return this.db.prepare(`SELECT * FROM holdings WHERE id = ?`).get(id) as
      | HoldingRow
      | undefined;
  }

  list(opts: { status?: HoldingStatus } = {}): HoldingRow[] {
    if (opts.status) {
      return this.db
        .prepare(`SELECT * FROM holdings WHERE status = ? ORDER BY created_at ASC`)
        .all(opts.status) as HoldingRow[];
    }
    return this.db.prepare(`SELECT * FROM holdings ORDER BY created_at ASC`).all() as HoldingRow[];
  }

  remove(id: string): boolean {
    const info = this.db.prepare(`DELETE FROM holdings WHERE id = ?`).run(id);
    return info.changes > 0;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
