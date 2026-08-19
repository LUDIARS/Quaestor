/**
 * 登録済み受領者メールへの C&R (OTP)。 役割は「パスキー初回登録の本人紐付けゲート」であり、
 * OTP 通過は合意を作らず、 1 回限りの登録許可 (enrollment grant) を発行する。
 * 最終合意はパスキー署名 (invoice-share-passkey-acceptance-service.ts) だけが作る。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-003 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  InvoiceShareAcceptanceRepo,
  InvoiceShareAcceptanceRow,
} from "../db/invoice-share-acceptance-repo.js";
import type { InvoiceShareChallengeRepo } from "../db/invoice-share-challenge-repo.js";
import type {
  InvoiceShareEnrollmentGrantRepo,
  InvoiceShareEnrollmentGrantRow,
} from "../db/invoice-share-enrollment-grant-repo.js";
import type { InvoiceEmailNotifier } from "./invoice-email-notifier.js";
import { InvoiceEmailError } from "./invoice-email-notifier.js";
import type { InvoiceShareService } from "./invoice-share-service.js";

const CHALLENGE_TTL_SECONDS = 15 * 60;
const GRANT_TTL_SECONDS = 15 * 60;
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

export interface ConfirmInvoiceShareChallengeInput {
  token: string;
  challengeId: string;
  code: string;
}

export interface IssuedEnrollmentGrant {
  grantId: string;
  expiresAt: number;
}

export interface InvoiceShareAcceptanceServiceOptions {
  shares: InvoiceShareService;
  acceptances: InvoiceShareAcceptanceRepo;
  challenges: InvoiceShareChallengeRepo;
  grants: InvoiceShareEnrollmentGrantRepo;
  notifier?: InvoiceEmailNotifier;
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
    if (!recipientEmail || !verified.share.recipient_id) {
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
    if (!notifier) throw new InvoiceEmailError("not_configured", "SES email is not configured", 503);
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
        subject: "【Qs】パスキー登録のための本人確認コード",
        text: [
          `${verified.share.recipient_company ?? verified.invoice.client} ご担当者様`,
          "",
          "請求内容への合意に使うパスキーを登録するため、確認画面に次のコードを入力してください。",
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

  /**
   * OTP を検証し、 パスキー登録許可 (grant) を発行する。 合意行は作らない。
   * challenge は原子的に 1 回だけ消費し、並行した再送から複数 grant を発行しない。
   */
  async confirm(input: ConfirmInvoiceShareChallengeInput): Promise<IssuedEnrollmentGrant> {
    const verified = await this.options.shares.loadDocument(input.token, false);
    if (this.options.acceptances.findByShareId(verified.share.id)) {
      throw new InvoiceShareChallengeError("invalid_challenge", "invoice share is already accepted", 404);
    }
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
    if (!verified.share.recipient_id) {
      throw new InvoiceShareChallengeError("recipient_required", "registered recipient is required", 400);
    }
    if (!this.options.challenges.consume(challenge.id, now)) {
      throw new InvoiceShareChallengeError("invalid_challenge", "confirmation challenge was already used", 404);
    }
    const grantId = this.idFactory();
    const expiresAt = now + GRANT_TTL_SECONDS;
    this.options.grants.insert({
      id: grantId,
      shareId: verified.share.id,
      contactId: verified.share.recipient_id,
      otpChallengeId: challenge.id,
      grantHash: grantHash(input.token, grantId),
      createdAt: now,
      expiresAt,
    });
    return { grantId, expiresAt };
  }

  /** grant が「この token のこの share」に対して有効か。 消費はしない。 */
  findValidGrant(token: string, shareId: string, grantId: string): InvoiceShareEnrollmentGrantRow | undefined {
    const grant = this.options.grants.find(grantId);
    if (!grant || grant.share_id !== shareId || grant.consumed_at !== null) return undefined;
    if (grant.expires_at < this.now()) return undefined;
    const expected = Buffer.from(grant.grant_hash, "hex");
    const actual = Buffer.from(grantHash(token, grantId), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    return grant;
  }

  consumeGrant(grantId: string): boolean {
    return this.options.grants.consume(grantId, this.now());
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

function grantHash(token: string, grantId: string): string {
  return createHmac("sha256", token).update(`enrollment-grant:${grantId}`).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!local || !domain) return MASKED_RECIPIENT_EMAIL_FALLBACK;
  return `${local.slice(0, 1)}***@${domain}`;
}
