/**
 * 添付付きメールの MIME (RFC 2045/2047) 組み立て。 SESv2 `Content.Raw` 用。 依存なし。
 * 本文は UTF-8 text/plain (base64)、 添付は base64。 ヘッダーの改行混入は除去する。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-007 (spec/feature/invoice-public-magic-link.md)
 */

import { randomBytes } from "node:crypto";
import type { InvoiceEmailMessage } from "./invoice-email-notifier.js";

const CRLF = "\r\n";

export function buildMimeMessage(input: {
  from: string;
  message: InvoiceEmailMessage;
  boundary?: string;
}): Buffer {
  const boundary = input.boundary ?? `qs-${randomBytes(12).toString("hex")}`;
  const lines: string[] = [
    `From: ${stripBreaks(input.from)}`,
    `To: ${stripBreaks(input.message.to)}`,
    `Subject: ${encodeHeaderWord(input.message.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(input.message.text, "utf8").toString("base64")),
  ];
  for (const attachment of input.message.attachments ?? []) {
    const filename = encodeHeaderWord(attachment.filename);
    lines.push(
      `--${boundary}`,
      `Content-Type: ${stripBreaks(attachment.contentType)}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      wrap76(attachment.content.toString("base64")),
    );
  }
  lines.push(`--${boundary}--`, "");
  return Buffer.from(lines.join(CRLF), "utf8");
}

/** 非 ASCII を含むヘッダー値は RFC 2047 の B エンコードにする。 */
function encodeHeaderWord(value: string): string {
  const clean = stripBreaks(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(clean) && !clean.includes('"')) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function stripBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function wrap76(base64: string): string {
  return base64.match(/.{1,76}/g)?.join(CRLF) ?? "";
}
