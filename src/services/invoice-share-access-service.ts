/**
 * 公開リクエストの識別情報を最小化して、請求書リンクのアクセス証跡を作る。
 *
 * @implements SPEC-INVOICE-ACCESS-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCESS-002 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  InvoiceShareAccessEventType,
  InvoiceShareAccessRepo,
  InvoiceShareAccessRow,
} from "../db/invoice-share-access-repo.js";
import type { InvoiceShareRow } from "../db/invoice-share-repo.js";
import {
  evaluateAcceptanceLocation,
  type CloudflareVisitorLocation,
  type InvoiceAcceptanceLocationReference,
} from "./invoice-acceptance-location-signal.js";

export interface RecordInvoiceShareAccessInput {
  share: InvoiceShareRow;
  eventType: InvoiceShareAccessEventType;
  clientAddress?: string;
  cfRay?: string;
  userAgent?: string;
  cloudflareClientAddress?: string;
  visitorLocation?: CloudflareVisitorLocation;
}

export interface InvoiceShareAccessServiceOptions {
  accesses: InvoiceShareAccessRepo;
  locationReference?: InvoiceAcceptanceLocationReference | null;
  now?: () => number;
  idFactory?: () => string;
}

export class InvoiceShareAccessService {
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(private readonly options: InvoiceShareAccessServiceOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.idFactory = options.idFactory ?? randomUUID;
  }

  record(input: RecordInvoiceShareAccessInput): InvoiceShareAccessRow {
    const accessedAt = this.now();
    const cfRay = safeCfRay(input.cfRay);
    const clientAddressSha256 = sha256((input.clientAddress ?? "unknown").slice(0, 256));
    const userAgentSha256 = sha256((input.userAgent ?? "").slice(0, 2048));
    const locationSignal = evaluateAcceptanceLocation(
      input.visitorLocation,
      this.options.locationReference ?? null,
      cfRay,
      input.cloudflareClientAddress,
    );
    const evidence = {
      shareId: input.share.id,
      invoiceId: input.share.invoice_id,
      eventType: input.eventType,
      accessedAt,
      cfRay,
      clientAddressSha256,
      userAgentSha256,
      locationSource: locationSignal.source,
      locationCountryCode: locationSignal.countryCode,
      locationRegionCode: locationSignal.regionCode,
      issuerReferenceProximity: locationSignal.issuerReferenceProximity,
    };
    return this.options.accesses.record({
      id: this.idFactory(),
      ...evidence,
      evidenceSha256: sha256(JSON.stringify(evidence)),
    });
  }

  list(shareId: string, limit: number): { items: InvoiceShareAccessRow[]; total: number } {
    return {
      items: this.options.accesses.listByShareId(shareId, limit),
      total: this.options.accesses.countByShareId(shareId),
    };
  }
}

function safeCfRay(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && /^[A-Za-z0-9-]{1,100}$/.test(candidate) ? candidate : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
