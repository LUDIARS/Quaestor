/**
 * 請求内容への明示合意を、共有リンクごとに一度だけ保存する。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-002 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-007 (spec/feature/invoice-public-magic-link.md)
 */

import type Database from "better-sqlite3";

export type AcceptanceAuthenticationMethod = "passkey" | "email_otp" | "legacy_link_confirmation";
export type EvidenceTimestampStatus = "pending" | "granted" | "failed" | "skipped";

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
  authentication_method: AcceptanceAuthenticationMethod;
  challenge_id: string | null;
  location_source: "cloudflare_ip_geolocation" | "unavailable";
  location_country_code: string | null;
  location_region_code: string | null;
  issuer_reference_proximity: "inside" | "outside" | "unavailable";
  evidence_sha256: string;
  passkey_id: string | null;
  credential_id: string | null;
  statement_json: string | null;
  client_data_json: string | null;
  authenticator_data_b64url: string | null;
  assertion_signature_b64url: string | null;
  public_key_sha256: string | null;
  timestamp_status: EvidenceTimestampStatus;
  timestamp_authority: string | null;
  timestamp_token: Buffer | null;
  timestamp_requested_at: number | null;
  timestamp_granted_at: number | null;
  timestamp_attempts: number;
  timestamp_last_error: string | null;
}

/** パスキー署名による合意の証跡。 `authentication_method = 'passkey'` のときだけ埋まる。 */
export interface PasskeyAcceptanceEvidence {
  passkeyId: string;
  credentialId: string;
  statementJson: string;
  clientDataJson: string;
  authenticatorDataB64url: string;
  assertionSignatureB64url: string;
  publicKeySha256: string;
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
  authenticationMethod: "passkey";
  challengeId: string;
  locationSource: "cloudflare_ip_geolocation" | "unavailable";
  locationCountryCode: string | null;
  locationRegionCode: string | null;
  issuerReferenceProximity: "inside" | "outside" | "unavailable";
  evidenceSha256: string;
  passkey: PasskeyAcceptanceEvidence;
  timestampStatus: Extract<EvidenceTimestampStatus, "pending" | "skipped">;
  timestampAuthority: string | null;
}

export interface EvidenceTimestampUpdate {
  status: EvidenceTimestampStatus;
  token?: Buffer | null;
  requestedAt: number;
  grantedAt?: number | null;
  lastError?: string | null;
}

export class InvoiceShareAcceptanceRepo {
  constructor(private readonly db: Database.Database) {}

  record(input: RecordInvoiceShareAcceptanceInput): {
    acceptance: InvoiceShareAcceptanceRow;
    created: boolean;
  } {
    const created = this.db.prepare(
      `INSERT INTO invoice_share_acceptances
       (id, share_id, invoice_id, recipient_company, recipient_email,
        document_sha256, agreement_version, agreement_text, accepted_at,
        cf_ray, user_agent_sha256, authentication_method, challenge_id,
        location_source, location_country_code, location_region_code,
        issuer_reference_proximity, evidence_sha256,
        passkey_id, credential_id, statement_json, client_data_json,
        authenticator_data_b64url, assertion_signature_b64url, public_key_sha256,
        timestamp_status, timestamp_authority)
       VALUES (@id, @shareId, @invoiceId, @recipientCompany, @recipientEmail,
               @documentSha256, @agreementVersion, @agreementText, @acceptedAt,
               @cfRay, @userAgentSha256, @authenticationMethod, @challengeId,
               @locationSource, @locationCountryCode, @locationRegionCode,
               @issuerReferenceProximity, @evidenceSha256,
               @passkeyId, @credentialId, @statementJson, @clientDataJson,
               @authenticatorDataB64url, @assertionSignatureB64url, @publicKeySha256,
               @timestampStatus, @timestampAuthority)
       ON CONFLICT(share_id) DO NOTHING`,
    ).run({ ...input, ...input.passkey, passkey: undefined }).changes > 0;
    return { acceptance: this.findByShareId(input.shareId)!, created };
  }

  findByShareId(shareId: string): InvoiceShareAcceptanceRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_share_acceptances WHERE share_id = ?",
    ).get(shareId) as InvoiceShareAcceptanceRow | undefined;
  }

  find(id: string): InvoiceShareAcceptanceRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_share_acceptances WHERE id = ?",
    ).get(id) as InvoiceShareAcceptanceRow | undefined;
  }

  /** 外部タイムスタンプがまだ付いていない合意行 (古い順)。 再試行ジョブが拾う。 */
  listTimestampPending(limit: number): InvoiceShareAcceptanceRow[] {
    return this.db.prepare(
      `SELECT * FROM invoice_share_acceptances
       WHERE timestamp_status = 'pending' ORDER BY accepted_at ASC LIMIT ?`,
    ).all(limit) as InvoiceShareAcceptanceRow[];
  }

  /** granted になった行は二度と書き換えない (証跡の不変性)。 */
  updateTimestamp(id: string, update: EvidenceTimestampUpdate): boolean {
    return this.db.prepare(
      `UPDATE invoice_share_acceptances
       SET timestamp_status = @status,
           timestamp_token = COALESCE(@token, timestamp_token),
           timestamp_requested_at = @requestedAt,
           timestamp_granted_at = @grantedAt,
           timestamp_attempts = timestamp_attempts + 1,
           timestamp_last_error = @lastError
       WHERE id = @id AND timestamp_status <> 'granted'`,
    ).run({
      id,
      status: update.status,
      token: update.token ?? null,
      requestedAt: update.requestedAt,
      grantedAt: update.grantedAt ?? null,
      lastError: update.lastError ?? null,
    }).changes > 0;
  }
}
