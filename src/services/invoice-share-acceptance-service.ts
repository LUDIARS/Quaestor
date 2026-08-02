/**
 * 公開マジックリンクからの請求内容合意を、検証済みPDFへ結び付けて記録する。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-002 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  InvoiceShareAcceptanceRepo,
  InvoiceShareAcceptanceRow,
} from "../db/invoice-share-acceptance-repo.js";
import type { InvoiceShareService } from "./invoice-share-service.js";
import { INVOICE_AGREEMENT_TEXT, INVOICE_AGREEMENT_VERSION } from "../invoices/invoice-agreement.js";

export interface AcceptInvoiceShareInput {
  token: string;
  cfRay?: string;
  userAgent?: string;
}

export interface InvoiceShareAcceptanceServiceOptions {
  shares: InvoiceShareService;
  acceptances: InvoiceShareAcceptanceRepo;
  now?: () => number;
  idFactory?: () => string;
}

export class InvoiceShareAcceptanceService {
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(private readonly options: InvoiceShareAcceptanceServiceOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.idFactory = options.idFactory ?? randomUUID;
  }

  find(shareId: string): InvoiceShareAcceptanceRow | undefined {
    return this.options.acceptances.findByShareId(shareId);
  }

  async accept(input: AcceptInvoiceShareInput): Promise<InvoiceShareAcceptanceRow> {
    // 合意対象は配信時にハッシュ固定したPDFそのもの。差し替えがあれば409で記録しない。
    const verified = await this.options.shares.loadDocument(input.token, false);
    const acceptedAt = this.now();
    const cfRay = safeCfRay(input.cfRay);
    const userAgentSha256 = sha256((input.userAgent ?? "").slice(0, 2048));
    const evidence = {
      shareId: verified.share.id,
      invoiceId: verified.invoice.id,
      recipientCompany: verified.share.recipient_company,
      recipientEmail: verified.share.recipient_email,
      documentSha256: verified.share.document_sha256,
      agreementVersion: INVOICE_AGREEMENT_VERSION,
      agreementText: INVOICE_AGREEMENT_TEXT,
      acceptedAt,
      cfRay,
      userAgentSha256,
    };
    return this.options.acceptances.record({
      id: this.idFactory(),
      ...evidence,
      evidenceSha256: sha256(JSON.stringify(evidence)),
    });
  }
}

function safeCfRay(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && /^[A-Za-z0-9-]{1,100}$/.test(candidate) ? candidate : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
