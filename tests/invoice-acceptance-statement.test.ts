import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  ACCEPTANCE_STATEMENT_VERSION,
  canonicalJson,
  challengeOf,
  parseStatement,
  serializeStatement,
  statementMatches,
  type InvoiceAcceptanceStatement,
} from "../src/services/invoice-acceptance-statement.js";

const STATEMENT: InvoiceAcceptanceStatement = {
  v: ACCEPTANCE_STATEMENT_VERSION,
  share_id: "share-1",
  invoice_id: 7,
  document_sha256: "a".repeat(64),
  agreement_version: "invoice-content-v1",
  agreement_text: "合意します",
  recipient_company: "Example",
  recipient_email_sha256: "b".repeat(64),
  issued_at: 1_000,
  expires_at: 1_300,
  nonce: "nonce",
};

describe("invoice acceptance statement", () => {
  it("正規化はキー昇順・空白なしで、 入力のキー順に依存しない", () => {
    const shuffled = Object.fromEntries(Object.entries(STATEMENT).reverse()) as unknown as InvoiceAcceptanceStatement;
    expect(serializeStatement(shuffled)).toBe(serializeStatement(STATEMENT));
    expect(canonicalJson({ b: { d: 1, c: [ { z: 1, y: 2 } ] }, a: null })).toBe('{"a":null,"b":{"c":[{"y":2,"z":1}],"d":1}}');
  });

  it("challenge は正規化 JSON の SHA-256 (base64url)", () => {
    const json = serializeStatement(STATEMENT);
    expect(challengeOf(json)).toBe(createHash("sha256").update(json).digest("base64url"));
    expect(challengeOf(json.replace('"nonce":"nonce"', '"nonce":"other"'))).not.toBe(challengeOf(json));
  });

  it("parse は版・必須フィールドを検証し、 matches は share/document/agreement の一致を見る", () => {
    const json = serializeStatement(STATEMENT);
    const parsed = parseStatement(json)!;
    expect(parsed).toEqual(STATEMENT);
    expect(parseStatement("{")).toBeNull();
    expect(parseStatement(JSON.stringify({ ...STATEMENT, v: "x" }))).toBeNull();
    expect(parseStatement(JSON.stringify({ ...STATEMENT, nonce: 1 }))).toBeNull();
    const expected = { shareId: "share-1", documentSha256: "a".repeat(64), agreementVersion: "invoice-content-v1" };
    expect(statementMatches(parsed, expected)).toBe(true);
    expect(statementMatches(parsed, { ...expected, documentSha256: "c".repeat(64) })).toBe(false);
    expect(statementMatches(parsed, { ...expected, shareId: "share-2" })).toBe(false);
    expect(statementMatches(parsed, { ...expected, agreementVersion: "v2" })).toBe(false);
  });
});
