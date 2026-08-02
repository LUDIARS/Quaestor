/**
 * 請求内容への明示合意を、共有リンクごとに一度だけ保存する。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-002 (spec/feature/invoice-public-magic-link.md)
 */

import type Database from "better-sqlite3";

export interface InvoiceShareAcceptanceRow {
  id: string;
  share_id: string;
  invoice_id: number;
  recipient_company: string | null;
  recipient_email: string | null;
  document_sha256: string;
  agreement_version: string;
  agreement_text: string;
  accepted_at: number;
  cf_ray: string | null;
  user_agent_sha256: string;
  authentication_method: "email_otp" | "legacy_link_confirmation";
  challenge_id: string | null;
  location_source: "cloudflare_ip_geolocation" | "unavailable";
  location_country_code: string | null;
  location_region_code: string | null;
  issuer_reference_proximity: "inside" | "outside" | "unavailable";
  evidence_sha256: string;
}

export interface RecordInvoiceShareAcceptanceInput {
  id: string;
  shareId: string;
  invoiceId: number;
  recipientCompany: string | null;
  recipientEmail: string | null;
  documentSha256: string;
  agreementVersion: string;
  agreementText: string;
  acceptedAt: number;
  cfRay: string | null;
  userAgentSha256: string;
  authenticationMethod: "email_otp";
  challengeId: string;
  locationSource: "cloudflare_ip_geolocation" | "unavailable";
  locationCountryCode: string | null;
  locationRegionCode: string | null;
  issuerReferenceProximity: "inside" | "outside" | "unavailable";
  evidenceSha256: string;
}

export class InvoiceShareAcceptanceRepo {
  constructor(private readonly db: Database.Database) {}

  record(input: RecordInvoiceShareAcceptanceInput): InvoiceShareAcceptanceRow {
    this.db.prepare(
      `INSERT INTO invoice_share_acceptances
       (id, share_id, invoice_id, recipient_company, recipient_email,
        document_sha256, agreement_version, agreement_text, accepted_at,
        cf_ray, user_agent_sha256, authentication_method, challenge_id,
        location_source, location_country_code, location_region_code,
        issuer_reference_proximity, evidence_sha256)
       VALUES (@id, @shareId, @invoiceId, @recipientCompany, @recipientEmail,
               @documentSha256, @agreementVersion, @agreementText, @acceptedAt,
               @cfRay, @userAgentSha256, @authenticationMethod, @challengeId,
               @locationSource, @locationCountryCode, @locationRegionCode,
               @issuerReferenceProximity, @evidenceSha256)
       ON CONFLICT(share_id) DO NOTHING`,
    ).run(input);
    return this.findByShareId(input.shareId)!;
  }

  findByShareId(shareId: string): InvoiceShareAcceptanceRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_share_acceptances WHERE share_id = ?",
    ).get(shareId) as InvoiceShareAcceptanceRow | undefined;
  }
}
