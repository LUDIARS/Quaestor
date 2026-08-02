/**
 * 登録済み受領者メールへの C&R を通過した合意だけを監査記録へ確定する。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-002 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-003 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  InvoiceShareAcceptanceRepo,
  InvoiceShareAcceptanceRow,
} from "../db/invoice-share-acceptance-repo.js";
import type { InvoiceShareChallengeRepo } from "../db/invoice-share-challenge-repo.js";
import { INVOICE_AGREEMENT_TEXT, INVOICE_AGREEMENT_VERSION } from "../invoices/invoice-agreement.js";
import type { InvoiceEmailNotifier } from "./invoice-email-notifier.js";
import { InvoiceEmailError } from "./invoice-email-notifier.js";
import {
  evaluateAcceptanceLocation,
  type CloudflareVisitorLocation,
  type InvoiceAcceptanceLocationReference,
} from "./invoice-acceptance-location-signal.js";
import type { InvoiceShareService } from "./invoice-share-service.js";

const CHALLENGE_TTL_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 5;
/**
 * 失敗上限に達した challenge は active から外れるため、上限だけでは再発行によって
 * 6桁コードの試行回数が実質無制限になる。 share ごとの発行総数も閉じ、
 * 総試行回数を MAX_ATTEMPTS × MAX_CHALLENGES_PER_SHARE に固定する。
 */
const MAX_CHALLENGES_PER_SHARE = 5;

/** 宛先を特定できない画面 (確認失敗の再描画など) で使う伏せ字ラベル。 */
export const MASKED_RECIPIENT_EMAIL_FALLBACK = "登録済みメールアドレス";

export class InvoiceShareChallengeError extends Error {
  constructor(
    readonly code: "recipient_required" | "invalid_challenge" | "expired" | "locked" | "delivery_failed",
    message: string,
    readonly status: 400 | 404 | 410 | 429 | 502,
  ) {
    super(message);
  }
}

export interface BeginInvoiceShareAcceptanceInput {
  token: string;
}

export interface BegunInvoiceShareAcceptance {
  challengeId: string;
  expiresAt: number;
  maskedEmail: string;
}

export interface ConfirmInvoiceShareAcceptanceInput {
  token: string;
  challengeId: string;
  code: string;
  cfRay?: string;
  userAgent?: string;
  cloudflareClientAddress?: string;
  visitorLocation?: CloudflareVisitorLocation;
}

export interface InvoiceShareAcceptanceServiceOptions {
  shares: InvoiceShareService;
  acceptances: InvoiceShareAcceptanceRepo;
  challenges: InvoiceShareChallengeRepo;
  notifier?: InvoiceEmailNotifier;
  locationReference?: InvoiceAcceptanceLocationReference | null;
  now?: () => number;
  idFactory?: () => string;
  codeFactory?: () => string;
}

export class InvoiceShareAcceptanceService {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly codeFactory: () => string;

  constructor(private readonly options: InvoiceShareAcceptanceServiceOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.idFactory = options.idFactory ?? randomUUID;
    this.codeFactory = options.codeFactory ?? (() => randomInt(100_000, 1_000_000).toString());
  }

  find(shareId: string): InvoiceShareAcceptanceRow | undefined {
    return this.options.acceptances.findByShareId(shareId);
  }

  async begin(input: BeginInvoiceShareAcceptanceInput): Promise<BegunInvoiceShareAcceptance> {
    const verified = await this.options.shares.loadDocument(input.token, false);
    const recipientEmail = verified.share.recipient_email;
    if (!recipientEmail) {
      throw new InvoiceShareChallengeError("recipient_required", "registered recipient email is required", 400);
    }
    if (this.options.acceptances.findByShareId(verified.share.id)) {
      throw new InvoiceShareChallengeError("invalid_challenge", "invoice share is already accepted", 404);
    }
    const createdAt = this.now();
    const active = this.options.challenges.findLatestActiveForShare(verified.share.id, createdAt);
    if (active) {
      return { challengeId: active.id, expiresAt: active.expires_at, maskedEmail: maskEmail(recipientEmail) };
    }
    if (this.options.challenges.countForShare(verified.share.id) >= MAX_CHALLENGES_PER_SHARE) {
      throw new InvoiceShareChallengeError(
        "locked",
        "confirmation code re-issue limit reached for this share",
        429,
      );
    }
    const notifier = this.options.notifier;
    if (!notifier) throw new InvoiceEmailError("not_configured", "Gmail ADC is not configured", 503);
    notifier.assertReady();
    const id = this.idFactory();
    const code = this.codeFactory();
    if (!/^\d{6}$/.test(code)) throw new Error("codeFactory returned an invalid code");
    const expiresAt = createdAt + CHALLENGE_TTL_SECONDS;
    this.options.challenges.insert({
      id,
      shareId: verified.share.id,
      destinationSha256: sha256(recipientEmail.trim().toLowerCase()),
      codeHash: challengeHash(input.token, id, code),
      createdAt,
      expiresAt,
      maxAttempts: MAX_ATTEMPTS,
    });
    try {
      await notifier.sendMessage({
        to: recipientEmail,
        subject: "【Qs】請求内容への合意確認コード",
        text: [
          `${verified.share.recipient_company ?? verified.invoice.client} ご担当者様`,
          "",
          "請求内容への合意を確定するため、確認画面に次のコードを入力してください。",
          "",
          code,
          "",
          "コードの有効期限は15分、入力は5回までです。",
          "この操作に心当たりがない場合は、コードを入力せず送信元へご連絡ください。",
        ].join("\n"),
      });
    } catch (error) {
      this.options.challenges.remove(id);
      if (error instanceof InvoiceEmailError) throw error;
      throw new InvoiceShareChallengeError("delivery_failed", "confirmation code delivery failed", 502);
    }
    return { challengeId: id, expiresAt, maskedEmail: maskEmail(recipientEmail) };
  }

  async confirm(input: ConfirmInvoiceShareAcceptanceInput): Promise<InvoiceShareAcceptanceRow> {
    const verified = await this.options.shares.loadDocument(input.token, false);
    const existing = this.options.acceptances.findByShareId(verified.share.id);
    if (existing) return existing;
    const challenge = this.options.challenges.find(input.challengeId);
    if (!challenge || challenge.share_id !== verified.share.id || challenge.consumed_at !== null) {
      throw new InvoiceShareChallengeError("invalid_challenge", "confirmation challenge is invalid", 404);
    }
    const now = this.now();
    if (challenge.expires_at < now) {
      throw new InvoiceShareChallengeError("expired", "confirmation code has expired", 410);
    }
    if (challenge.attempt_count >= challenge.max_attempts) {
      throw new InvoiceShareChallengeError("locked", "confirmation code is locked", 429);
    }
    if (!/^\d{6}$/.test(input.code)) throw this.failAttempt(challenge, now);
    const expected = Buffer.from(challenge.code_hash, "hex");
    const actual = Buffer.from(challengeHash(input.token, challenge.id, input.code), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw this.failAttempt(challenge, now);
    }
    const acceptedAt = now;
    const cfRay = safeCfRay(input.cfRay);
    const userAgentSha256 = sha256((input.userAgent ?? "").slice(0, 2048));
    const locationSignal = evaluateAcceptanceLocation(
      input.visitorLocation,
      this.options.locationReference ?? null,
      cfRay,
      input.cloudflareClientAddress,
    );
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
      authenticationMethod: "email_otp" as const,
      challengeId: challenge.id,
      locationSource: locationSignal.source,
      locationCountryCode: locationSignal.countryCode,
      locationRegionCode: locationSignal.regionCode,
      issuerReferenceProximity: locationSignal.issuerReferenceProximity,
    };
    const acceptance = this.options.acceptances.record({
      id: this.idFactory(),
      ...evidence,
      evidenceSha256: sha256(JSON.stringify(evidence)),
    });
    this.options.challenges.consume(challenge.id, now);
    return acceptance;
  }

  /**
   * 失敗を1回記録し、ロック済みかどうかを UPDATE の結果から判定する。
   * 並行 POST で読み取り値が古くても、実際に加算できなかった時点でロック扱いにする。
   */
  private failAttempt(
    challenge: { id: string; attempt_count: number; max_attempts: number },
    now: number,
  ): InvoiceShareChallengeError {
    const counted = this.options.challenges.recordFailedAttempt(challenge.id, now);
    const exhausted = !counted || challenge.attempt_count + 1 >= challenge.max_attempts;
    return new InvoiceShareChallengeError(
      exhausted ? "locked" : "invalid_challenge",
      exhausted ? "confirmation code is locked" : "confirmation code is invalid",
      exhausted ? 429 : 400,
    );
  }
}

function challengeHash(token: string, challengeId: string, code: string): string {
  return createHmac("sha256", token).update(`${challengeId}:${code}`).digest("hex");
}

function safeCfRay(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && /^[A-Za-z0-9-]{1,100}$/.test(candidate) ? candidate : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!local || !domain) return MASKED_RECIPIENT_EMAIL_FALLBACK;
  return `${local.slice(0, 1)}***@${domain}`;
}
