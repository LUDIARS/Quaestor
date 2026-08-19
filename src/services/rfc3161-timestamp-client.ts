/**
 * RFC 3161 タイムスタンプ局 (TSA) クライアント。 証跡ハッシュ (SHA-256) を TimeStampReq (DER) にして
 * HTTP POST し、 応答の TimeStampResp をそのまま保存用に返す。 依存を増やさず、 要求の DER は
 * 手書きエンコード、 応答は TimeStampToken/CMS/TSTInfo を DER 構造として辿り、署名対象の
 * messageImprint と nonce を確認する。証明書チェーンを含む完全な暗号検証は `openssl ts -verify`
 * 等の第三者ツールで行う (docs/invoice-acceptance-evidence-verification.md)。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-008 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash, randomBytes } from "node:crypto";

export const DEFAULT_TSA_URL = "https://freetsa.org/tsr";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** id-sha256: 2.16.840.1.101.3.4.2.1 */
const SHA256_ALGORITHM_IDENTIFIER = Buffer.from("300d06096086480165030402010500", "hex");
const SHA256_OID = Buffer.from("608648016503040201", "hex");
const SHA384_OID = Buffer.from("608648016503040202", "hex");
const SHA512_OID = Buffer.from("608648016503040203", "hex");
/** signedData: 1.2.840.113549.1.7.2 */
const SIGNED_DATA_OID = Buffer.from("2a864886f70d010702", "hex");
/** id-ct-TSTInfo: 1.2.840.113549.1.9.16.1.4 */
const TST_INFO_OID = Buffer.from("2a864886f70d0109100104", "hex");
/** content-type / message-digest signed attributes */
const CONTENT_TYPE_ATTRIBUTE_OID = Buffer.from("2a864886f70d010903", "hex");
const MESSAGE_DIGEST_ATTRIBUTE_OID = Buffer.from("2a864886f70d010904", "hex");

export class Rfc3161Error extends Error {
  constructor(
    readonly code: "transport" | "rejected" | "malformed" | "mismatch",
    message: string,
  ) {
    super(message);
  }
}

export interface TimestampTokenResult {
  /** TimeStampResp 全体 (DER)。 保存・第三者検証用。 */
  response: Buffer;
  /** PKIStatus: 0 granted / 1 grantedWithMods */
  status: 0 | 1;
  nonce: Buffer;
}

export interface Rfc3161TimestampClientOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  nonceFactory?: () => Buffer;
  timeoutMs?: number;
}

export class Rfc3161TimestampClient {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nonceFactory: () => Buffer;
  private readonly timeoutMs: number;

  constructor(options: Rfc3161TimestampClientOptions = {}) {
    this.url = normalizeTimestampAuthorityUrl(options.url ?? DEFAULT_TSA_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nonceFactory = options.nonceFactory ?? (() => randomBytes(8));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** `sha256Hex` は 64 桁 hex。 granted の TSTInfo が同じ imprint と nonce を持つことを確認して返す。 */
  async timestamp(sha256Hex: string): Promise<TimestampTokenResult> {
    if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Rfc3161Error("malformed", "message imprint must be sha256 hex");
    const imprint = Buffer.from(sha256Hex, "hex");
    const nonce = this.nonceFactory();
    const request = encodeTimeStampReq(imprint, nonce);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" },
        body: new Uint8Array(request),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new Rfc3161Error("transport", "timestamp authority is unreachable");
    }
    if (!response.ok) throw new Rfc3161Error("transport", `timestamp authority returned HTTP ${response.status}`);
    const body = await readBoundedResponseBody(response, MAX_RESPONSE_BYTES);
    if (body.byteLength === 0) {
      throw new Rfc3161Error("malformed", "timestamp response has an unexpected size");
    }
    const status = readPkiStatus(body);
    if (status !== 0 && status !== 1) throw new Rfc3161Error("rejected", `timestamp request rejected (status ${status})`);
    verifyTimeStampToken(body, imprint, nonce);
    return { response: body, status, nonce };
  }
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    throw new Rfc3161Error("malformed", "timestamp response exceeds the size limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Rfc3161Error("malformed", "timestamp response exceeds the size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function normalizeTimestampAuthorityUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Rfc3161Error("malformed", "timestamp authority URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Rfc3161Error("malformed", "timestamp authority URL must be a plain HTTPS endpoint");
  }
  return url.toString();
}

/**
 * TimeStampReq ::= SEQUENCE { version INTEGER 1, messageImprint SEQUENCE { sha256, OCTET STRING },
 *                             nonce INTEGER, certReq BOOLEAN TRUE }
 */
export function encodeTimeStampReq(imprint: Buffer, nonce: Buffer): Buffer {
  const version = Buffer.from([0x02, 0x01, 0x01]);
  const messageImprint = derSequence(Buffer.concat([SHA256_ALGORITHM_IDENTIFIER, derTlv(0x04, imprint)]));
  const certReq = Buffer.from([0x01, 0x01, 0xff]);
  return derSequence(Buffer.concat([version, messageImprint, derInteger(nonce), certReq]));
}

/** 非負整数として nonce を INTEGER 化 (先頭ビットが立っていれば 0x00 を前置)。 */
function derInteger(value: Buffer): Buffer {
  let body = value;
  while (body.length > 1 && body[0] === 0 && (body[1]! & 0x80) === 0) body = body.subarray(1);
  if (body.length === 0) body = Buffer.from([0]);
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body]);
  return derTlv(0x02, body);
}

function derSequence(body: Buffer): Buffer {
  return derTlv(0x30, body);
}

function derTlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) { bytes.unshift(rest & 0xff); rest >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** TimeStampResp → status.status。 */
export function readPkiStatus(response: Buffer): number {
  const outer = requireTlv(response, 0, 0x30, "TimeStampResp");
  if (outer.end !== response.length) throw new Rfc3161Error("malformed", "TimeStampResp has trailing data");
  const children = readChildren(response, outer);
  const statusInfo = children[0];
  if (!statusInfo || statusInfo.tag !== 0x30) throw new Rfc3161Error("malformed", "PKIStatusInfo is not a SEQUENCE");
  const status = readChildren(response, statusInfo)[0];
  if (!status || status.tag !== 0x02 || status.length < 1 || status.length > 4) {
    throw new Rfc3161Error("malformed", "PKIStatus is not an INTEGER");
  }
  return response.subarray(status.bodyStart, status.bodyEnd).readUIntBE(0, status.length);
}

interface DerTlv {
  tag: number;
  length: number;
  start: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
}

/**
 * granted 応答の TimeStampToken を ContentInfo → SignedData → EncapsulatedContentInfo → TSTInfo
 * の順に辿る。単なる byte search では、無関係な OCTET STRING に imprint/nonce を混ぜた偽応答を
 * 受理できるため、必ず署名対象の eContent 内だけを検証する。
 */
function verifyTimeStampToken(response: Buffer, expectedImprint: Buffer, expectedNonce: Buffer): void {
  const outer = requireTlv(response, 0, 0x30, "TimeStampResp");
  const responseChildren = readChildren(response, outer);
  if (responseChildren.length !== 2) {
    throw new Rfc3161Error("malformed", "granted TimeStampResp must contain one TimeStampToken");
  }
  const contentInfo = responseChildren[1]!;
  requireTag(contentInfo, 0x30, "TimeStampToken ContentInfo");
  const contentInfoChildren = readChildren(response, contentInfo);
  requireOid(response, contentInfoChildren[0], SIGNED_DATA_OID, "TimeStampToken content type");
  const explicitSignedData = contentInfoChildren[1];
  requireTag(explicitSignedData, 0xa0, "TimeStampToken content");
  const explicitChildren = readChildren(response, explicitSignedData!);
  if (explicitChildren.length !== 1) throw new Rfc3161Error("malformed", "SignedData wrapper is malformed");

  const signedData = explicitChildren[0]!;
  requireTag(signedData, 0x30, "SignedData");
  const signedDataChildren = readChildren(response, signedData);
  if (signedDataChildren.length < 4) throw new Rfc3161Error("malformed", "SignedData is incomplete");
  requireTag(signedDataChildren[0], 0x02, "SignedData version");
  requireTag(signedDataChildren[1], 0x31, "SignedData digestAlgorithms");
  const encapContentInfo = signedDataChildren[2]!;
  requireTag(encapContentInfo, 0x30, "EncapsulatedContentInfo");
  const signerInfos = signedDataChildren[signedDataChildren.length - 1]!;
  requireTag(signerInfos, 0x31, "SignedData signerInfos");

  const encapChildren = readChildren(response, encapContentInfo);
  requireOid(response, encapChildren[0], TST_INFO_OID, "encapsulated content type");
  const explicitContent = encapChildren[1];
  requireTag(explicitContent, 0xa0, "TSTInfo content");
  const contentChildren = readChildren(response, explicitContent!);
  if (contentChildren.length !== 1 || contentChildren[0]!.tag !== 0x04) {
    throw new Rfc3161Error("malformed", "TSTInfo content is not an OCTET STRING");
  }
  const tstInfoBytes = response.subarray(contentChildren[0]!.bodyStart, contentChildren[0]!.bodyEnd);
  verifySignerInfos(response, signerInfos, tstInfoBytes);
  verifyTstInfo(tstInfoBytes, expectedImprint, expectedNonce);
}

function verifySignerInfos(response: Buffer, signerInfos: DerTlv, tstInfoBytes: Buffer): void {
  const infos = readChildren(response, signerInfos);
  if (infos.length === 0) throw new Rfc3161Error("malformed", "TimeStampToken has no signer info");
  for (const info of infos) {
    requireTag(info, 0x30, "SignerInfo");
    const fields = readChildren(response, info);
    if (fields.length < 6) throw new Rfc3161Error("malformed", "SignerInfo is incomplete");
    requireTag(fields[0], 0x02, "SignerInfo version");
    if (fields[1]!.tag !== 0x30 && fields[1]!.tag !== 0x80) {
      throw new Rfc3161Error("malformed", "SignerInfo identifier is malformed");
    }
    const digestAlgorithm = digestAlgorithmName(response, fields[2], "SignerInfo digestAlgorithm");
    const expectedDigest = createHash(digestAlgorithm).update(tstInfoBytes).digest();
    const signedAttributes = fields[3];
    requireTag(signedAttributes, 0xa0, "SignerInfo signedAttrs");
    verifySignedAttributes(response, signedAttributes, expectedDigest);
    requireTag(fields[4], 0x30, "SignerInfo signatureAlgorithm");
    requireTag(fields[5], 0x04, "SignerInfo signature");
    if (fields[5]!.length === 0) throw new Rfc3161Error("malformed", "SignerInfo signature is empty");
  }
}

function verifySignedAttributes(response: Buffer, signedAttributes: DerTlv, expectedDigest: Buffer): void {
  let hasContentType = false;
  let hasMessageDigest = false;
  for (const attribute of readChildren(response, signedAttributes)) {
    requireTag(attribute, 0x30, "signed attribute");
    const fields = readChildren(response, attribute);
    if (fields.length !== 2 || fields[0]!.tag !== 0x06 || fields[1]!.tag !== 0x31) continue;
    const oid = response.subarray(fields[0]!.bodyStart, fields[0]!.bodyEnd);
    const values = readChildren(response, fields[1]!);
    if (oid.equals(CONTENT_TYPE_ATTRIBUTE_OID)) {
      requireOid(response, values[0], TST_INFO_OID, "signed content type");
      hasContentType = values.length === 1;
    } else if (oid.equals(MESSAGE_DIGEST_ATTRIBUTE_OID)) {
      const digest = values[0];
      requireTag(digest, 0x04, "signed message digest");
      hasMessageDigest = values.length === 1
        && response.subarray(digest!.bodyStart, digest!.bodyEnd).equals(expectedDigest);
    }
  }
  if (!hasContentType || !hasMessageDigest) {
    throw new Rfc3161Error("mismatch", "TimeStampToken signed attributes do not match TSTInfo");
  }
}

function verifyTstInfo(tstInfoBytes: Buffer, expectedImprint: Buffer, expectedNonce: Buffer): void {
  const tstInfo = requireTlv(tstInfoBytes, 0, 0x30, "TSTInfo");
  if (tstInfo.end !== tstInfoBytes.length) throw new Rfc3161Error("malformed", "TSTInfo has trailing data");
  const fields = readChildren(tstInfoBytes, tstInfo);
  if (fields.length < 5) throw new Rfc3161Error("malformed", "TSTInfo is incomplete");
  requireTag(fields[0], 0x02, "TSTInfo version");
  requireTag(fields[1], 0x06, "TSTInfo policy");
  const messageImprint = fields[2]!;
  requireTag(messageImprint, 0x30, "TSTInfo messageImprint");
  requireTag(fields[3], 0x02, "TSTInfo serialNumber");
  requireTag(fields[4], 0x18, "TSTInfo genTime");

  const imprintFields = readChildren(tstInfoBytes, messageImprint);
  if (imprintFields.length !== 2) throw new Rfc3161Error("malformed", "messageImprint is malformed");
  const algorithm = imprintFields[0]!;
  requireSha256Algorithm(tstInfoBytes, algorithm, "messageImprint algorithm");
  const hashedMessage = imprintFields[1]!;
  requireTag(hashedMessage, 0x04, "messageImprint hashedMessage");
  if (!tstInfoBytes.subarray(hashedMessage.bodyStart, hashedMessage.bodyEnd).equals(expectedImprint)) {
    throw new Rfc3161Error("mismatch", "timestamp token message imprint does not match the request");
  }

  const nonce = fields.slice(5).find((field) => field.tag === 0x02);
  if (!nonce) throw new Rfc3161Error("mismatch", "timestamp token does not carry the request nonce");
  const actualNonce = normalizePositiveInteger(tstInfoBytes.subarray(nonce.bodyStart, nonce.bodyEnd));
  const requestedNonce = normalizeUnsignedInteger(expectedNonce);
  if (!actualNonce.equals(requestedNonce)) {
    throw new Rfc3161Error("mismatch", "timestamp token nonce does not match the request");
  }
}

function requireSha256Algorithm(buffer: Buffer, algorithm: DerTlv | undefined, label: string): void {
  if (digestAlgorithmName(buffer, algorithm, label) !== "sha256") {
    throw new Rfc3161Error("malformed", `${label} must be SHA-256`);
  }
}

function digestAlgorithmName(
  buffer: Buffer,
  algorithm: DerTlv | undefined,
  label: string,
): "sha256" | "sha384" | "sha512" {
  requireTag(algorithm, 0x30, label);
  const fields = readChildren(buffer, algorithm);
  requireTag(fields[0], 0x06, label);
  if (fields.length > 2 || (fields[1] && (fields[1]!.tag !== 0x05 || fields[1]!.length !== 0))) {
    throw new Rfc3161Error("malformed", `${label} parameters are malformed`);
  }
  const oid = buffer.subarray(fields[0]!.bodyStart, fields[0]!.bodyEnd);
  if (oid.equals(SHA256_OID)) return "sha256";
  if (oid.equals(SHA384_OID)) return "sha384";
  if (oid.equals(SHA512_OID)) return "sha512";
  throw new Rfc3161Error("malformed", `${label} is unsupported`);
}

function normalizeUnsignedInteger(value: Buffer): Buffer {
  if (value.length === 0) throw new Rfc3161Error("malformed", "request nonce is empty");
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  return value.subarray(start);
}

function normalizePositiveInteger(value: Buffer): Buffer {
  if (value.length === 0 || (value[0]! & 0x80) !== 0) {
    throw new Rfc3161Error("malformed", "DER INTEGER is not a non-negative value");
  }
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  return value.subarray(start);
}

function requireOid(buffer: Buffer, tlv: DerTlv | undefined, expectedBody: Buffer, label: string): void {
  requireTag(tlv, 0x06, label);
  if (!buffer.subarray(tlv!.bodyStart, tlv!.bodyEnd).equals(expectedBody)) {
    throw new Rfc3161Error("malformed", `${label} is unsupported`);
  }
}

function requireTag(tlv: DerTlv | null | undefined, tag: number, label: string): asserts tlv is DerTlv {
  if (!tlv || tlv.tag !== tag) throw new Rfc3161Error("malformed", `${label} has an unexpected DER tag`);
}

function requireTlv(buffer: Buffer, offset: number, tag: number, label: string): DerTlv {
  const tlv = readTlv(buffer, offset);
  requireTag(tlv, tag, label);
  return tlv;
}

function readChildren(buffer: Buffer, parent: DerTlv): DerTlv[] {
  const children: DerTlv[] = [];
  let offset = parent.bodyStart;
  while (offset < parent.bodyEnd) {
    const child = readTlv(buffer, offset);
    if (!child || child.end > parent.bodyEnd) throw new Rfc3161Error("malformed", "DER child exceeds its parent");
    children.push(child);
    offset = child.end;
  }
  if (offset !== parent.bodyEnd) throw new Rfc3161Error("malformed", "DER children do not fill their parent");
  return children;
}

function readTlv(buffer: Buffer, offset: number): DerTlv | null {
  if (offset + 2 > buffer.length) return null;
  const tag = buffer[offset]!;
  if ((tag & 0x1f) === 0x1f) return null;
  const first = buffer[offset + 1]!;
  if ((first & 0x80) === 0) return boundedTlv(buffer, offset, tag, offset + 2, first);
  const count = first & 0x7f;
  if (count === 0 || count > 4 || offset + 2 + count > buffer.length) return null;
  if (buffer[offset + 2] === 0) return null;
  const length = buffer.subarray(offset + 2, offset + 2 + count).readUIntBE(0, count);
  if (length < 0x80) return null;
  return boundedTlv(buffer, offset, tag, offset + 2 + count, length);
}

function boundedTlv(buffer: Buffer, start: number, tag: number, bodyStart: number, length: number): DerTlv | null {
  const bodyEnd = bodyStart + length;
  if (!Number.isSafeInteger(bodyEnd) || bodyEnd > buffer.length) return null;
  return { tag, length, start, bodyStart, bodyEnd, end: bodyEnd };
}
