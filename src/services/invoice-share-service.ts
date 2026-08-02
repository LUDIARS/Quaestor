/**
 * 請求書PDFの発行時検証・トークン化・宛先スナップショット・公開時再検証。
 *
 * @implements SPEC-INVOICE-DELIVERY-002 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { InvoiceRow, InvoicesRepo } from "../db/invoices-repo.js";
import type { InvoiceShareRepo, InvoiceShareRow } from "../db/invoice-share-repo.js";
import type { InvoiceDeliveryContactsRepo } from "../db/invoice-delivery-contacts-repo.js";

const DEFAULT_TTL_DAYS = 14;
const MAX_TTL_DAYS = 30;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export class InvoiceShareError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_request" | "not_configured" | "document_invalid" | "document_changed",
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 503,
  ) {
    super(message);
  }
}

export interface CreateInvoiceShareInput {
  invoiceId: number;
  documentPath: string;
  expiresInDays?: number;
  recipientId?: string;
}

export interface CreatedInvoiceShare {
  id: string;
  url: string;
  expiresAt: number;
  filename: string;
  documentSha256: string;
  documentSize: number;
  recipientId: string | null;
  recipientCompany: string | null;
  recipientEmail: string | null;
}

export interface PublicInvoiceShare {
  share: InvoiceShareRow;
  invoice: InvoiceRow;
}

export interface InvoiceShareDocument extends PublicInvoiceShare {
  contents: Buffer;
}

export interface InvoiceShareServiceOptions {
  shares: InvoiceShareRepo;
  invoices: InvoicesRepo;
  publicBaseUrl?: string;
  allowedRoots?: string[];
  now?: () => number;
  tokenFactory?: () => string;
  idFactory?: () => string;
  contacts?: InvoiceDeliveryContactsRepo;
}

export class InvoiceShareService {
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly idFactory: () => string;
  private readonly allowedRoots: string[];
  /** 設定値 root → realpath 済 root。 root 自体が symlink 経由でも判定が壊れないようにする。 */
  private readonly canonicalRoots = new Map<string, string>();

  constructor(private readonly options: InvoiceShareServiceOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.idFactory = options.idFactory ?? randomUUID;
    this.allowedRoots = (options.allowedRoots ?? defaultShareRoots()).map((root) => resolve(root));
    if (this.allowedRoots.length === 0) throw new Error("at least one invoice share root is required");
  }

  async create(input: CreateInvoiceShareInput): Promise<CreatedInvoiceShare> {
    const publicBaseUrl = this.requirePublicBaseUrl();
    const invoice = this.options.invoices.find(input.invoiceId);
    if (!invoice || invoice.status === "cancelled") {
      throw new InvoiceShareError("not_found", "invoice not found", 404);
    }
    const expiresInDays = input.expiresInDays ?? DEFAULT_TTL_DAYS;
    if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_TTL_DAYS) {
      throw new InvoiceShareError("invalid_request", `expiresInDays must be between 1 and ${MAX_TTL_DAYS}`, 400);
    }

    const document = await this.inspectPdf(input.documentPath);
    const documentSha256 = await hashFile(document.path);
    const recipient = input.recipientId
      ? this.options.contacts?.findActive(input.recipientId)
      : undefined;
    if (input.recipientId && !recipient) {
      throw new InvoiceShareError("not_found", "active invoice delivery contact not found", 404);
    }
    const token = this.tokenFactory();
    if (!TOKEN_PATTERN.test(token)) throw new Error("tokenFactory returned an invalid opaque token");
    const createdAt = this.now();
    const expiresAt = createdAt + expiresInDays * 24 * 60 * 60;
    const row = this.options.shares.insert({
      id: this.idFactory(),
      invoiceId: invoice.id,
      tokenHash: sha256(token),
      documentPath: document.path,
      documentSha256,
      documentSize: document.size,
      filename: document.filename,
      recipientId: recipient?.id,
      recipientCompany: recipient?.company_name,
      recipientEmail: recipient?.email,
      expiresAt,
      createdAt,
    });
    return {
      id: row.id,
      url: `${publicBaseUrl}/v1/invoices/share/${token}`,
      expiresAt,
      filename: row.filename,
      documentSha256: row.document_sha256,
      documentSize: row.document_size,
      recipientId: row.recipient_id,
      recipientCompany: row.recipient_company,
      recipientEmail: row.recipient_email,
    };
  }

  async findPublic(token: string, recordView = true): Promise<PublicInvoiceShare> {
    if (!TOKEN_PATTERN.test(token)) throw notFound();
    const now = this.now();
    const share = this.options.shares.findActiveByTokenHash(sha256(token), now);
    if (!share) throw notFound();
    const invoice = this.options.invoices.find(share.invoice_id);
    if (!invoice || invoice.status === "cancelled") throw notFound();
    if (recordView && !this.options.shares.recordView(share.id, now)) throw notFound();
    return { share, invoice };
  }

  async loadDocument(token: string, recordView = true): Promise<InvoiceShareDocument> {
    const result = await this.findPublic(token, false);
    const inspected = await this.inspectPdf(result.share.document_path);
    if (inspected.size !== result.share.document_size) {
      throw new InvoiceShareError("document_changed", "shared invoice document changed after link creation", 409);
    }
    // 実際に配信するバイト列そのものを検証する。 stat 後の差し替えもここで落ちる。
    const contents = await readFile(inspected.path);
    if (contents.length !== result.share.document_size || sha256(contents) !== result.share.document_sha256) {
      throw new InvoiceShareError("document_changed", "shared invoice document changed after link creation", 409);
    }
    if (recordView && !this.options.shares.recordView(result.share.id, this.now())) throw notFound();
    return { ...result, contents };
  }

  revoke(invoiceId: number, shareId: string): boolean {
    return this.options.shares.revoke(shareId, invoiceId, this.now());
  }

  findById(shareId: string): InvoiceShareRow | undefined {
    return this.options.shares.findById(shareId);
  }

  private requirePublicBaseUrl(): string {
    const value = this.options.publicBaseUrl?.trim().replace(/\/+$/, "");
    if (!value) throw new InvoiceShareError("not_configured", "invoiceShare.publicUrl is required", 503);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new InvoiceShareError("not_configured", "invoiceShare.publicUrl is invalid", 503);
    }
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.pathname !== "/"
    ) {
      throw new InvoiceShareError(
        "not_configured",
        "invoiceShare.publicUrl must be an HTTPS origin without path, credentials, query, or fragment",
        503,
      );
    }
    return value;
  }

  private async inspectPdf(inputPath: string): Promise<{
    path: string;
    filename: string;
    size: number;
  }> {
    const canonicalPath = await realpath(resolve(inputPath)).catch(() => null);
    if (!canonicalPath || !(await this.isAllowedPath(canonicalPath)) || extname(canonicalPath).toLowerCase() !== ".pdf") {
      throw new InvoiceShareError("document_invalid", "document must be a PDF inside an allowed invoice root", 400);
    }
    const fileStat = await stat(canonicalPath).catch(() => null);
    if (!fileStat?.isFile()) throw new InvoiceShareError("document_invalid", "invoice PDF was not found", 400);
    if (fileStat.size <= 0 || fileStat.size > MAX_PDF_BYTES) {
      throw new InvoiceShareError("document_invalid", "invoice PDF size is invalid", 413);
    }
    const handle = await open(canonicalPath, "r");
    try {
      const header = Buffer.alloc(5);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || header.toString("ascii") !== "%PDF-") {
        throw new InvoiceShareError("document_invalid", "document does not have a PDF signature", 400);
      }
    } finally {
      await handle.close();
    }
    return {
      path: canonicalPath,
      filename: basename(canonicalPath),
      size: fileStat.size,
    };
  }

  private async isAllowedPath(candidate: string): Promise<boolean> {
    for (const root of this.allowedRoots) {
      const pathWithinRoot = relative(await this.canonicalRoot(root), candidate);
      if (pathWithinRoot !== "" && !pathWithinRoot.startsWith("..") && !isAbsolute(pathWithinRoot)) return true;
    }
    return false;
  }

  /** candidate は realpath 済なので root 側も realpath して比較する。 解決不能な root は解決を保留する。 */
  private async canonicalRoot(root: string): Promise<string> {
    const cached = this.canonicalRoots.get(root);
    if (cached) return cached;
    const canonical = await realpath(root).catch(() => null);
    if (canonical) this.canonicalRoots.set(root, canonical);
    return canonical ?? root;
  }
}

/**
 * allowedRoots 未指定時の fallback。 設定の正本は app-config.ts の `invoiceShare.roots`
 * (env override は `QUAESTOR_INVOICE_SHARE_ROOTS`) で、 ここは env を直接読まない。
 */
function defaultShareRoots(): string[] {
  return ["data", "app_data/invoices"];
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function notFound(): InvoiceShareError {
  return new InvoiceShareError("not_found", "invoice share link is invalid or expired", 404);
}
