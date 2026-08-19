/**
 * パスキーが署名する「合意ステートメント」。 WebAuthn の challenge を statement の SHA-256 から導出する
 * ことで、 署名 → challenge → statement → 請求書 PDF の SHA-256 が 1 本の連鎖で結ばれる。
 * 純粋関数のみ。 正規化は「キー昇順・空白なし」 で、 検証側が同じ bytes を再現できる。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-006 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash } from "node:crypto";

export const ACCEPTANCE_STATEMENT_VERSION = "invoice-acceptance-statement-v1";

export interface InvoiceAcceptanceStatement {
  v: typeof ACCEPTANCE_STATEMENT_VERSION;
  share_id: string;
  invoice_id: number;
  document_sha256: string;
  agreement_version: string;
  agreement_text: string;
  recipient_company: string | null;
  recipient_email_sha256: string | null;
  issued_at: number;
  expires_at: number;
  nonce: string;
}

/** JSON をキー昇順・空白なしで直列化する。 ネストしたオブジェクトも再帰的に並べ替える。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function base64url(value: Buffer | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

/** statement → 正規化 JSON。 DB とバンドルにはこの文字列をそのまま保存する。 */
export function serializeStatement(statement: InvoiceAcceptanceStatement): string {
  return canonicalJson(statement);
}

/** WebAuthn challenge (bytes) = SHA-256(正規化 JSON)。 options には base64url で載る。 */
export function challengeBytesOf(statementJson: string): Buffer {
  return createHash("sha256").update(statementJson).digest();
}

export function challengeOf(statementJson: string): string {
  return base64url(challengeBytesOf(statementJson));
}

/** 保存済み statement JSON を型付きで読む。 壊れていれば null。 */
export function parseStatement(statementJson: string): InvoiceAcceptanceStatement | null {
  try {
    const parsed = JSON.parse(statementJson) as Partial<InvoiceAcceptanceStatement>;
    if (parsed.v !== ACCEPTANCE_STATEMENT_VERSION) return null;
    if (typeof parsed.share_id !== "string" || typeof parsed.document_sha256 !== "string") return null;
    if (typeof parsed.nonce !== "string" || typeof parsed.expires_at !== "number") return null;
    return parsed as InvoiceAcceptanceStatement;
  } catch {
    return null;
  }
}

/**
 * statement が「今この share のこの PDF」を指しているか。 challenge 発行後に PDF が差し替わった場合や
 * 他 share の statement を持ち込まれた場合に false。
 */
export function statementMatches(
  statement: InvoiceAcceptanceStatement,
  expected: { shareId: string; documentSha256: string; agreementVersion: string },
): boolean {
  return statement.share_id === expected.shareId
    && statement.document_sha256 === expected.documentSha256
    && statement.agreement_version === expected.agreementVersion;
}
