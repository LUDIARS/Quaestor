/**
 * 受領者と発行者の双方が手元に置ける「合意証跡バンドル」。 DB を見ずに署名検証を再現できる材料を
 * 1 つの JSON にまとめる。 純粋関数 (入力は監査行とパスキー行)。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-007 (spec/feature/invoice-public-magic-link.md)
 */

import type { InvoiceShareAcceptanceRow } from "../db/invoice-share-acceptance-repo.js";
import type { InvoiceRecipientPasskeyRow } from "../db/invoice-recipient-passkey-repo.js";
import { publicKeyObjectFromCose } from "./invoice-passkey-service.js";
import { canonicalJson, sha256Hex } from "./invoice-acceptance-statement.js";

export const EVIDENCE_BUNDLE_FORMAT = "quaestor-invoice-acceptance-evidence-v1";
export const EVIDENCE_VERIFICATION_DOC = "docs/invoice-acceptance-evidence-verification.md";

/** RFC 3161 の messageImprint にする、タイムスタンプ非依存の自己完結した証跡。 */
export interface InvoiceAcceptanceEvidenceDigestPayload {
  format: typeof EVIDENCE_BUNDLE_FORMAT;
  statement: unknown;
  assertion: {
    client_data_json_b64url: string;
    authenticator_data_b64url: string;
    signature_b64url: string;
  };
  credential: {
    id_b64url: string;
    algorithm: number;
    public_key_cose_b64url: string;
    public_key_sha256: string;
  };
  acceptance: {
    acceptance_id: string;
    share_id: string;
    invoice_id: number;
    accepted_at: number;
    document_sha256: string;
    agreement_version: string;
    agreement_text: string;
  };
}

export interface BuildEvidenceDigestPayloadInput {
  statementJson: string;
  clientDataJson: string;
  authenticatorDataB64url: string;
  signatureB64url: string;
  credentialId: string;
  credentialAlgorithm: number;
  publicKeyCoseB64url: string;
  publicKeySha256: string;
  acceptanceId: string;
  shareId: string;
  invoiceId: number;
  acceptedAt: number;
  documentSha256: string;
  agreementVersion: string;
  agreementText: string;
}

export interface InvoiceAcceptanceEvidenceBundle {
  format: typeof EVIDENCE_BUNDLE_FORMAT;
  statement: unknown;
  assertion: {
    client_data_json_b64url: string;
    authenticator_data_b64url: string;
    signature_b64url: string;
  };
  credential: {
    id_b64url: string;
    algorithm: number;
    public_key_cose_b64url: string;
    public_key_spki_pem: string;
    public_key_jwk: Record<string, unknown>;
    public_key_sha256: string;
  };
  acceptance: {
    acceptance_id: string;
    share_id: string;
    invoice_id: number;
    accepted_at: number;
    accepted_at_iso: string;
    document_sha256: string;
    agreement_version: string;
    agreement_text: string;
    evidence_sha256: string;
  };
  timestamp:
    | { status: "granted"; authority: string; token_der_b64: string; granted_at: number }
    | { status: "pending" | "failed" | "skipped"; authority: string | null };
  verify: string;
}

/** DB 保存前と、後からのバンドル再構築で同じ digest 入力を作る。 */
export function buildEvidenceDigestPayload(
  input: BuildEvidenceDigestPayloadInput,
): InvoiceAcceptanceEvidenceDigestPayload {
  return {
    format: EVIDENCE_BUNDLE_FORMAT,
    statement: JSON.parse(input.statementJson) as unknown,
    assertion: {
      client_data_json_b64url: Buffer.from(input.clientDataJson, "utf8").toString("base64url"),
      authenticator_data_b64url: input.authenticatorDataB64url,
      signature_b64url: input.signatureB64url,
    },
    credential: {
      id_b64url: input.credentialId,
      algorithm: input.credentialAlgorithm,
      public_key_cose_b64url: input.publicKeyCoseB64url,
      public_key_sha256: input.publicKeySha256,
    },
    acceptance: {
      acceptance_id: input.acceptanceId,
      share_id: input.shareId,
      invoice_id: input.invoiceId,
      accepted_at: input.acceptedAt,
      document_sha256: input.documentSha256,
      agreement_version: input.agreementVersion,
      agreement_text: input.agreementText,
    },
  };
}

export function evidenceSha256OfPayload(payload: InvoiceAcceptanceEvidenceDigestPayload): string {
  return sha256Hex(canonicalJson(payload));
}

/** 配布された JSON だけから TSA の messageImprint を再計算する。 */
export function evidenceSha256OfBundle(bundle: InvoiceAcceptanceEvidenceBundle): string {
  return evidenceSha256OfPayload({
    format: bundle.format,
    statement: bundle.statement,
    assertion: bundle.assertion,
    credential: {
      id_b64url: bundle.credential.id_b64url,
      algorithm: bundle.credential.algorithm,
      public_key_cose_b64url: bundle.credential.public_key_cose_b64url,
      public_key_sha256: bundle.credential.public_key_sha256,
    },
    acceptance: {
      acceptance_id: bundle.acceptance.acceptance_id,
      share_id: bundle.acceptance.share_id,
      invoice_id: bundle.acceptance.invoice_id,
      accepted_at: bundle.acceptance.accepted_at,
      document_sha256: bundle.acceptance.document_sha256,
      agreement_version: bundle.acceptance.agreement_version,
      agreement_text: bundle.acceptance.agreement_text,
    },
  });
}

/** `authentication_method='passkey'` の行だけバンドル化できる。 それ以外は null。 */
export function buildEvidenceBundle(
  acceptance: InvoiceShareAcceptanceRow,
  passkey: InvoiceRecipientPasskeyRow,
): InvoiceAcceptanceEvidenceBundle | null {
  if (
    acceptance.authentication_method !== "passkey"
    || !acceptance.statement_json || !acceptance.client_data_json
    || !acceptance.authenticator_data_b64url || !acceptance.assertion_signature_b64url
    || !acceptance.credential_id
  ) {
    return null;
  }
  const keyObject = publicKeyObjectFromCose(passkey.public_key_cose);
  const payload = buildEvidenceDigestPayload({
    statementJson: acceptance.statement_json,
    clientDataJson: acceptance.client_data_json,
    authenticatorDataB64url: acceptance.authenticator_data_b64url,
    signatureB64url: acceptance.assertion_signature_b64url,
    credentialId: acceptance.credential_id,
    credentialAlgorithm: passkey.algorithm,
    publicKeyCoseB64url: passkey.public_key_cose,
    publicKeySha256: passkey.public_key_sha256,
    acceptanceId: acceptance.id,
    shareId: acceptance.share_id,
    invoiceId: acceptance.invoice_id,
    acceptedAt: acceptance.accepted_at,
    documentSha256: acceptance.document_sha256,
    agreementVersion: acceptance.agreement_version,
    agreementText: acceptance.agreement_text,
  });
  const bundle: InvoiceAcceptanceEvidenceBundle = {
    format: payload.format,
    statement: payload.statement,
    assertion: {
      ...payload.assertion,
    },
    credential: {
      ...payload.credential,
      public_key_spki_pem: keyObject.export({ type: "spki", format: "pem" }).toString(),
      public_key_jwk: keyObject.export({ format: "jwk" }) as Record<string, unknown>,
    },
    acceptance: {
      ...payload.acceptance,
      accepted_at_iso: new Date(acceptance.accepted_at * 1000).toISOString(),
      evidence_sha256: acceptance.evidence_sha256,
    },
    timestamp: acceptance.timestamp_status === "granted" && acceptance.timestamp_token && acceptance.timestamp_authority
      ? {
        status: "granted",
        authority: acceptance.timestamp_authority,
        token_der_b64: Buffer.from(acceptance.timestamp_token).toString("base64"),
        granted_at: acceptance.timestamp_granted_at ?? acceptance.accepted_at,
      }
      : { status: acceptance.timestamp_status === "granted" ? "pending" : acceptance.timestamp_status, authority: acceptance.timestamp_authority },
    verify: EVIDENCE_VERIFICATION_DOC,
  };
  return evidenceSha256OfBundle(bundle) === acceptance.evidence_sha256 ? bundle : null;
}

/** 添付ファイル名。 share id の先頭 8 桁で識別できれば十分。 */
export function evidenceBundleFilename(shareId: string): string {
  return `invoice-acceptance-${shareId.replace(/[^0-9a-z]/gi, "").slice(0, 8)}.json`;
}
