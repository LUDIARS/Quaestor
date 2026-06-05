/**
 * statement_profiles — クレカ/明細 CSV の列マッピング定義 (外部登録可能 importer) の repo。
 */

import type Database from "better-sqlite3";
import type { SourceKind } from "../shared/types.js";

export type ProfileEncoding = "auto" | "shift_jis" | "utf-8";
export type AmountSign = "out" | "in" | "signed";

export interface StatementProfileRow {
  id: number;
  name: string;
  brand: string;
  source: SourceKind;
  encoding: ProfileEncoding;
  header_skip: number;
  col_date: number;
  col_payee: number;
  col_amount: number;
  col_memo: number | null;
  amount_sign: AmountSign;
  filter_col: number | null;
  filter_value: string | null;
  date_year_hint: number | null;
  account_default: string | null;
  detect_keywords: string | null;   // JSON 配列
  enabled: number;                   // 0 / 1
  created_at: number;
  updated_at: number;
}

export interface UpsertProfileInput {
  name: string;
  brand: string;
  source?: SourceKind;
  encoding?: ProfileEncoding;
  header_skip?: number;
  col_date: number;
  col_payee: number;
  col_amount: number;
  col_memo?: number | null;
  amount_sign?: AmountSign;
  filter_col?: number | null;
  filter_value?: string | null;
  date_year_hint?: number | null;
  account_default?: string | null;
  detect_keywords?: string[] | null;
  enabled?: boolean;
}

export class StatementProfilesRepo {
  constructor(private readonly db: Database.Database) {}

  /** brand 衝突時は throw (UNIQUE)。 caller が 409 に変換する。 */
  insert(input: UpsertProfileInput): number {
    const now = nowSec();
    const r = this.db
      .prepare(
        `INSERT INTO statement_profiles
           (name, brand, source, encoding, header_skip, col_date, col_payee, col_amount, col_memo,
            amount_sign, filter_col, filter_value, date_year_hint, account_default, detect_keywords,
            enabled, created_at, updated_at)
         VALUES (@name,@brand,@source,@encoding,@header_skip,@col_date,@col_payee,@col_amount,@col_memo,
                 @amount_sign,@filter_col,@filter_value,@date_year_hint,@account_default,@detect_keywords,
                 @enabled,@now,@now)`,
      )
      .run(this.toParams(input, now));
    return Number(r.lastInsertRowid);
  }

  update(id: number, input: UpsertProfileInput): boolean {
    const now = nowSec();
    const r = this.db
      .prepare(
        `UPDATE statement_profiles SET
           name=@name, brand=@brand, source=@source, encoding=@encoding, header_skip=@header_skip,
           col_date=@col_date, col_payee=@col_payee, col_amount=@col_amount, col_memo=@col_memo,
           amount_sign=@amount_sign, filter_col=@filter_col, filter_value=@filter_value,
           date_year_hint=@date_year_hint, account_default=@account_default,
           detect_keywords=@detect_keywords, enabled=@enabled, updated_at=@now
         WHERE id=@id`,
      )
      .run({ ...this.toParams(input, now), id });
    return r.changes > 0;
  }

  find(id: number): StatementProfileRow | undefined {
    return this.db.prepare(`SELECT * FROM statement_profiles WHERE id = ?`).get(id) as
      | StatementProfileRow
      | undefined;
  }

  findByBrand(brand: string): StatementProfileRow | undefined {
    return this.db.prepare(`SELECT * FROM statement_profiles WHERE brand = ?`).get(brand) as
      | StatementProfileRow
      | undefined;
  }

  list(): StatementProfileRow[] {
    return this.db
      .prepare(`SELECT * FROM statement_profiles ORDER BY name ASC`)
      .all() as StatementProfileRow[];
  }

  listEnabled(): StatementProfileRow[] {
    return this.db
      .prepare(`SELECT * FROM statement_profiles WHERE enabled = 1 ORDER BY name ASC`)
      .all() as StatementProfileRow[];
  }

  delete(id: number): boolean {
    return this.db.prepare(`DELETE FROM statement_profiles WHERE id = ?`).run(id).changes > 0;
  }

  private toParams(input: UpsertProfileInput, now: number): Record<string, unknown> {
    return {
      name: input.name,
      brand: input.brand,
      source: input.source ?? "credit-card",
      encoding: input.encoding ?? "auto",
      header_skip: input.header_skip ?? 0,
      col_date: input.col_date,
      col_payee: input.col_payee,
      col_amount: input.col_amount,
      col_memo: input.col_memo ?? null,
      amount_sign: input.amount_sign ?? "out",
      filter_col: input.filter_col ?? null,
      filter_value: input.filter_value ?? null,
      date_year_hint: input.date_year_hint ?? null,
      account_default: input.account_default ?? null,
      detect_keywords: input.detect_keywords ? JSON.stringify(input.detect_keywords) : null,
      enabled: input.enabled === false ? 0 : 1,
      now,
    };
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
