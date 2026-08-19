/** テスト用の最小 TimeStampResp。暗号署名は行わないが、CMS/TSTInfo の DER 構造を再現する。 */

import { createHash } from "node:crypto";

const SHA256_ALGORITHM_IDENTIFIER = Buffer.from("300d06096086480165030402010500", "hex");
const SIGNED_DATA_OID = Buffer.from("06092a864886f70d010702", "hex");
const TST_INFO_OID = Buffer.from("060b2a864886f70d0109100104", "hex");
const CONTENT_TYPE_ATTRIBUTE_OID = Buffer.from("06092a864886f70d010903", "hex");
const MESSAGE_DIGEST_ATTRIBUTE_OID = Buffer.from("06092a864886f70d010904", "hex");
const SHA256_WITH_RSA_IDENTIFIER = Buffer.from("300d06092a864886f70d01010b0500", "hex");

export function fakeRfc3161Response(input: {
  status?: number;
  imprint: Buffer;
  nonce: Buffer;
}): Buffer {
  const statusInfo = sequence(integer(Buffer.from([input.status ?? 0])));
  const messageImprint = sequence(Buffer.concat([
    SHA256_ALGORITHM_IDENTIFIER,
    tlv(0x04, input.imprint),
  ]));
  const tstInfo = sequence(Buffer.concat([
    integer(Buffer.from([1])),
    tlv(0x06, Buffer.from("2a0304", "hex")),
    messageImprint,
    integer(Buffer.from([1])),
    tlv(0x18, Buffer.from("20260819000000Z", "ascii")),
    integer(input.nonce),
  ]));
  const encapContentInfo = sequence(Buffer.concat([
    TST_INFO_OID,
    tlv(0xa0, tlv(0x04, tstInfo)),
  ]));
  const contentTypeAttribute = sequence(Buffer.concat([
    CONTENT_TYPE_ATTRIBUTE_OID,
    tlv(0x31, TST_INFO_OID),
  ]));
  const messageDigestAttribute = sequence(Buffer.concat([
    MESSAGE_DIGEST_ATTRIBUTE_OID,
    tlv(0x31, tlv(0x04, createHash("sha256").update(tstInfo).digest())),
  ]));
  const signerInfo = sequence(Buffer.concat([
    integer(Buffer.from([1])),
    sequence(Buffer.alloc(0)),
    SHA256_ALGORITHM_IDENTIFIER,
    tlv(0xa0, Buffer.concat([contentTypeAttribute, messageDigestAttribute])),
    SHA256_WITH_RSA_IDENTIFIER,
    tlv(0x04, Buffer.from([1])),
  ]));
  const signedData = sequence(Buffer.concat([
    integer(Buffer.from([3])),
    tlv(0x31, SHA256_ALGORITHM_IDENTIFIER),
    encapContentInfo,
    tlv(0x31, signerInfo),
  ]));
  const token = sequence(Buffer.concat([SIGNED_DATA_OID, tlv(0xa0, signedData)]));
  return sequence(Buffer.concat([statusInfo, token]));
}

export function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function sequence(body: Buffer): Buffer {
  return tlv(0x30, body);
}

function integer(value: Buffer): Buffer {
  let body = value;
  while (body.length > 1 && body[0] === 0 && (body[1]! & 0x80) === 0) body = body.subarray(1);
  if (body.length === 0) body = Buffer.from([0]);
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
