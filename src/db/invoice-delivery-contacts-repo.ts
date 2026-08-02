/**
 * 請求書送信先台帳の永続化。
 *
 * @implements SPEC-INVOICE-DELIVERY-001 (spec/feature/invoice-public-magic-link.md)
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface InvoiceDeliveryContactRow {
  id: string;
  company_name: string;
  email: string;
  active: 0 | 1;
  created_at: number;
  updated_at: number;
}

export interface SaveInvoiceDeliveryContactInput {
  companyName: string;
  email: string;
  active?: boolean;
}

export interface InvoiceDeliveryContactsRepoOptions {
  now?: () => number;
  idFactory?: () => string;
}

export class InvoiceDeliveryContactsRepo {
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(
    private readonly db: Database.Database,
    options: InvoiceDeliveryContactsRepoOptions = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.idFactory = options.idFactory ?? randomUUID;
  }

  insert(input: SaveInvoiceDeliveryContactInput): InvoiceDeliveryContactRow {
    const now = this.now();
    const id = this.idFactory();
    this.db.prepare(
      `INSERT INTO invoice_delivery_contacts
       (id, company_name, email, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.companyName.trim(), normalizeEmail(input.email), input.active === false ? 0 : 1, now, now);
    return this.find(id)!;
  }

  /** active 省略時は現在値を保つ。 企業名・メールの編集だけで無効化済み送信先が復活しないようにする。 */
  update(id: string, input: SaveInvoiceDeliveryContactInput): InvoiceDeliveryContactRow | undefined {
    const result = this.db.prepare(
      `UPDATE invoice_delivery_contacts
       SET company_name = ?, email = ?, active = COALESCE(?, active), updated_at = ?
       WHERE id = ?`,
    ).run(
      input.companyName.trim(),
      normalizeEmail(input.email),
      input.active === undefined ? null : input.active ? 1 : 0,
      this.now(),
      id,
    );
    return result.changes > 0 ? this.find(id) : undefined;
  }

  deactivate(id: string): boolean {
    const result = this.db.prepare(
      `UPDATE invoice_delivery_contacts SET active = 0, updated_at = ? WHERE id = ?`,
    ).run(this.now(), id);
    return result.changes > 0;
  }

  find(id: string): InvoiceDeliveryContactRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_delivery_contacts WHERE id = ?",
    ).get(id) as InvoiceDeliveryContactRow | undefined;
  }

  findActive(id: string): InvoiceDeliveryContactRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_delivery_contacts WHERE id = ? AND active = 1",
    ).get(id) as InvoiceDeliveryContactRow | undefined;
  }

  list(includeInactive = false): InvoiceDeliveryContactRow[] {
    return this.db.prepare(
      `SELECT * FROM invoice_delivery_contacts
       ${includeInactive ? "" : "WHERE active = 1"}
       ORDER BY company_name COLLATE NOCASE, email COLLATE NOCASE`,
    ).all() as InvoiceDeliveryContactRow[];
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
