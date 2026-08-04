/**
 * 有効なマジックリンクへの成功アクセスを追記専用で保存する。
 *
 * @implements SPEC-INVOICE-ACCESS-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCESS-002 (spec/feature/invoice-public-magic-link.md)
 */

import type Database from "better-sqlite3";

export type InvoiceShareAccessEventType = "landing_view" | "document_view";

export interface InvoiceShareAccessRow {
  id: string;
  share_id: string;
  invoice_id: number;
  event_type: InvoiceShareAccessEventType;
  accessed_at: number;
  cf_ray: string | null;
  client_address_sha256: string;
  user_agent_sha256: string;
  location_source: "cloudflare_ip_geolocation" | "unavailable";
  location_country_code: string | null;
  location_region_code: string | null;
  issuer_reference_proximity: "inside" | "outside" | "unavailable";
  evidence_sha256: string;
}

export interface RecordInvoiceShareAccessInput {
  id: string;
  shareId: string;
  invoiceId: number;
  eventType: InvoiceShareAccessEventType;
  accessedAt: number;
  cfRay: string | null;
  clientAddressSha256: string;
  userAgentSha256: string;
  locationSource: "cloudflare_ip_geolocation" | "unavailable";
  locationCountryCode: string | null;
  locationRegionCode: string | null;
  issuerReferenceProximity: "inside" | "outside" | "unavailable";
  evidenceSha256: string;
}

export class InvoiceShareAccessRepo {
  constructor(private readonly db: Database.Database) {}

  record(input: RecordInvoiceShareAccessInput): InvoiceShareAccessRow {
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO invoice_share_access_logs
         (id, share_id, invoice_id, event_type, accessed_at, cf_ray,
          client_address_sha256, user_agent_sha256, location_source,
          location_country_code, location_region_code, issuer_reference_proximity,
          evidence_sha256)
         VALUES (@id, @shareId, @invoiceId, @eventType, @accessedAt, @cfRay,
                 @clientAddressSha256, @userAgentSha256, @locationSource,
                 @locationCountryCode, @locationRegionCode, @issuerReferenceProximity,
                 @evidenceSha256)`,
      ).run(input);
      this.db.prepare(
        `UPDATE invoice_share_tokens
         SET first_viewed_at = COALESCE(first_viewed_at, @accessedAt),
             last_viewed_at = @accessedAt,
             view_count = view_count + 1
         WHERE id = @shareId`,
      ).run(input);
    })();
    return this.find(input.id)!;
  }

  find(id: string): InvoiceShareAccessRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_share_access_logs WHERE id = ?",
    ).get(id) as InvoiceShareAccessRow | undefined;
  }

  listByShareId(shareId: string, limit: number): InvoiceShareAccessRow[] {
    return this.db.prepare(
      `SELECT * FROM invoice_share_access_logs
       WHERE share_id = ?
       ORDER BY accessed_at DESC, rowid DESC
       LIMIT ?`,
    ).all(shareId, limit) as InvoiceShareAccessRow[];
  }

  countByShareId(shareId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM invoice_share_access_logs WHERE share_id = ?",
    ).get(shareId) as { count: number };
    return row.count;
  }
}
