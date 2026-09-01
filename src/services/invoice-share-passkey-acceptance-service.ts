/**
 * パスキー署名による請求内容への合意。 登録 (grant 必須) → 合意ステートメントへの署名 → 監査行 →
 * 証跡バンドル → 外部タイムスタンプ、 のユースケースを 1 か所に持つ。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-002 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-004 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-006 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-007 (spec/feature/invoice-public-magic-link.md)
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import type {
  InvoiceShareAcceptanceRepo,
  InvoiceShareAcceptanceRow,
} from "../db/invoice-share-acceptance-repo.js";
import type { InvoiceRecipientPasskeyRepo } from "../db/invoice-recipient-passkey-repo.js";
import type { InvoiceShareWebAuthnChallengeRepo } from "../db/invoice-share-webauthn-challenge-repo.js";
import { INVOICE_AGREEMENT_TEXT, INVOICE_AGREEMENT_VERSION } from "../invoices/invoice-agreement.js";
import type { EvidenceTimestampService } from "./evidence-timestamp-service.js";
import {
  evaluateAcceptanceLocation,
  type CloudflareVisitorLocation,
  type InvoiceAcceptanceLocationReference,
} from "./invoice-acceptance-location-signal.js";
import {
  buildEvidenceDigestPayload,
  buildEvidenceBundle,
  evidenceSha256OfPayload,
  type InvoiceAcceptanceEvidenceBundle,
} from "./invoice-acceptance-evidence-bundle.js";
import type { InvoiceAcceptanceEvidenceMailer } from "./invoice-acceptance-evidence-mailer.js";
import {
  ACCEPTANCE_STATEMENT_VERSION,
  base64url,
  challengeBytesOf,
  challengeOf,
  parseStatement,
  serializeStatement,
  sha256Hex,
  statementMatches,
  type InvoiceAcceptanceStatement,
} from "./invoice-acceptance-statement.js";
import {
  InvoicePasskeyError,
  type AuthenticationResponseJSON,
  type InvoicePasskeyService,
  type RegistrationResponseJSON,
} from "./invoice-passkey-service.js";
import type { InvoiceShareAcceptanceService } from "./invoice-share-acceptance-service.js";
import type { InvoiceShareService } from "./invoice-share-service.js";

const CHALLENGE_TTL_SECONDS = 5 * 60;
/** リンク所持者が challenge 行を無限に増やせないように share ごとの発行総数を閉じる。 */
const MAX_CHALLENGES_PER_SHARE = 30;

export class InvoicePasskeyAcceptanceError extends Error {
  constructor(
    readonly code:
      | "recipient_required" | "already_accepted" | "no_passkey" | "invalid_grant"
      | "invalid_challenge" | "expired" | "locked" | "unknown_credential" | "verification_failed",
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 429,
  ) {
    super(message);
  }
}

export interface PasskeyAcceptanceStatus {
  shareId: string;
  accepted: InvoiceShareAcceptanceRow | undefined;
  /** 送信先台帳に紐づいていて、 有効なパスキーが 1 件以上ある */
  hasPasskey: boolean;
  recipientRegistered: boolean;
}

export interface AcceptWithPasskeyInput {
  token: string;
  challengeId: string;
  response: AuthenticationResponseJSON;
  cfRay?: string;
  userAgent?: string;
  cloudflareClientAddress?: string;
  visitorLocation?: CloudflareVisitorLocation;
}

export interface InvoiceSharePasskeyAcceptanceServiceOptions {
  shares: InvoiceShareService;
  acceptances: InvoiceShareAcceptanceRepo;
  passkeys: InvoiceRecipientPasskeyRepo;
  challenges: InvoiceShareWebAuthnChallengeRepo;
  otpGate: InvoiceShareAcceptanceService;
  webauthn: InvoicePasskeyService;
  timestamps: EvidenceTimestampService;
  evidenceMailer: InvoiceAcceptanceEvidenceMailer;
  locationReference?: InvoiceAcceptanceLocationReference | null;
  /** 証跡バンドル (`?view=evidence`) の絶対 URL を作るための公開 origin。 */
  publicUrl?: string;
  now?: () => number;
  idFactory?: () => string;
  nonceFactory?: () => Buffer;
}

export class InvoiceSharePasskeyAcceptanceService {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly nonceFactory: () => Buffer;

  constructor(private readonly options: InvoiceSharePasskeyAcceptanceServiceOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.idFactory = options.idFactory ?? randomUUID;
    this.nonceFactory = options.nonceFactory ?? (() => randomBytes(16));
  }

  async status(token: string): Promise<PasskeyAcceptanceStatus> {
    const verified = await this.options.shares.findPublic(token, false);
    const contactId = verified.share.recipient_id;
    const recipientEmailSha256 = recipientEmailSha256Of(verified.share.recipient_email);
    return {
      shareId: verified.share.id,
      accepted: this.options.acceptances.findByShareId(verified.share.id),
      hasPasskey: contactId && recipientEmailSha256
        ? this.options.passkeys.listActiveForRecipient(contactId, recipientEmailSha256).length > 0
        : false,
      recipientRegistered: contactId !== null && recipientEmailSha256 !== null,
    };
  }

  // ---- 登録 (OTP grant 必須) -------------------------------------------------

  async registrationOptions(input: { token: string; grantId: string }) {
    const verified = await this.options.shares.loadDocument(input.token, false);
    this.assertNotAccepted(verified.share.id);
    const grant = this.options.otpGate.findValidGrant(input.token, verified.share.id, input.grantId);
    if (!grant) throw new InvoicePasskeyAcceptanceError("invalid_grant", "enrollment grant is invalid", 403);
    const now = this.now();
    const challengeBytes = randomBytes(32);
    const challenge = base64url(challengeBytes);
    const challengeId = this.issueChallenge({
      token: input.token,
      shareId: verified.share.id,
      purpose: "register",
      challenge,
      statementJson: null,
      enrollmentGrantId: grant.id,
      now,
    });
    const recipientEmailSha256 = recipientEmailSha256Of(verified.share.recipient_email);
    if (!recipientEmailSha256) {
      throw new InvoicePasskeyAcceptanceError("recipient_required", "registered recipient email is required", 400);
    }
    const existing = this.options.passkeys.listActiveForRecipient(grant.contact_id, recipientEmailSha256);
    const options = await this.options.webauthn.registrationOptions({
      challenge: challengeBytes,
      userName: verified.share.recipient_email ?? verified.share.recipient_company ?? "recipient",
      userDisplayName: verified.share.recipient_company ?? verified.invoice.client,
      excludeCredentialIds: existing.map((row) => row.credential_id),
    });
    return { challengeId, options };
  }

  async register(input: {
    token: string;
    grantId: string;
    challengeId: string;
    response: RegistrationResponseJSON;
  }) {
    const verified = await this.options.shares.loadDocument(input.token, false);
    this.assertNotAccepted(verified.share.id);
    const grant = this.options.otpGate.findValidGrant(input.token, verified.share.id, input.grantId);
    if (!grant) throw new InvoicePasskeyAcceptanceError("invalid_grant", "enrollment grant is invalid", 403);
    const now = this.now();
    const challenge = this.consumeChallenge({
      token: input.token,
      shareId: verified.share.id,
      challengeId: input.challengeId,
      purpose: "register",
      clientDataJsonB64url: input.response.response.clientDataJSON,
      now,
    });
    if (challenge.enrollment_grant_id !== grant.id) {
      throw new InvoicePasskeyAcceptanceError("invalid_challenge", "challenge does not belong to this grant", 400);
    }
    let registered;
    try {
      registered = await this.options.webauthn.verifyRegistration({
        response: input.response,
        expectedChallenge: challenge.expectedChallenge,
      });
    } catch (error) {
      throw mapPasskeyError(error);
    }
    if (this.options.passkeys.findActiveByCredentialId(registered.credentialId)) {
      throw new InvoicePasskeyAcceptanceError("verification_failed", "credential is already registered", 400);
    }
    if (!this.options.otpGate.consumeGrant(grant.id)) {
      throw new InvoicePasskeyAcceptanceError("invalid_grant", "enrollment grant is no longer valid", 403);
    }
    const recipientEmailSha256 = recipientEmailSha256Of(verified.share.recipient_email);
    if (!recipientEmailSha256) {
      throw new InvoicePasskeyAcceptanceError("recipient_required", "registered recipient email is required", 400);
    }
    const row = this.options.passkeys.insert({
      id: this.idFactory(),
      contactId: grant.contact_id,
      recipientEmailSha256,
      credentialId: registered.credentialId,
      publicKeyCose: registered.publicKeyCose,
      publicKeySha256: registered.publicKeySha256,
      algorithm: registered.algorithm,
      signCount: registered.signCount,
      transports: registered.transports,
      aaguid: registered.aaguid,
      enrolledVia: "email_otp",
      enrollmentChallengeId: grant.otp_challenge_id,
      enrolledShareId: verified.share.id,
      createdAt: now,
    });
    return { passkeyId: row.id, publicKeySha256: row.public_key_sha256 };
  }

  // ---- 合意 (署名) -----------------------------------------------------------

  async assertionOptions(input: { token: string }) {
    const verified = await this.options.shares.loadDocument(input.token, false);
    this.assertNotAccepted(verified.share.id);
    const contactId = verified.share.recipient_id;
    if (!contactId) throw new InvoicePasskeyAcceptanceError("recipient_required", "registered recipient is required", 400);
    const recipientEmailSha256 = recipientEmailSha256Of(verified.share.recipient_email);
    if (!recipientEmailSha256) {
      throw new InvoicePasskeyAcceptanceError("recipient_required", "registered recipient email is required", 400);
    }
    const passkeys = this.options.passkeys.listActiveForRecipient(contactId, recipientEmailSha256);
    if (passkeys.length === 0) throw new InvoicePasskeyAcceptanceError("no_passkey", "no passkey is registered", 409);
    const now = this.now();
    const statement: InvoiceAcceptanceStatement = {
      v: ACCEPTANCE_STATEMENT_VERSION,
      share_id: verified.share.id,
      invoice_id: verified.invoice.id,
      document_sha256: verified.share.document_sha256,
      agreement_version: INVOICE_AGREEMENT_VERSION,
      agreement_text: INVOICE_AGREEMENT_TEXT,
      recipient_company: verified.share.recipient_company,
      recipient_email_sha256: verified.share.recipient_email
        ? sha256Hex(verified.share.recipient_email.trim().toLowerCase())
        : null,
      issued_at: now,
      expires_at: now + CHALLENGE_TTL_SECONDS,
      nonce: base64url(this.nonceFactory()),
    };
    const statementJson = serializeStatement(statement);
    const challengeId = this.issueChallenge({
      token: input.token,
      shareId: verified.share.id,
      purpose: "assert",
      challenge: challengeOf(statementJson),
      statementJson,
      enrollmentGrantId: null,
      now,
    });
    const options = await this.options.webauthn.authenticationOptions({
      challenge: challengeBytesOf(statementJson),
      allowCredentials: passkeys.map((row) => ({
        id: row.credential_id,
        transports: row.transports ? JSON.parse(row.transports) as string[] : null,
      })),
    });
    return { challengeId, options, statement };
  }

  async accept(input: AcceptWithPasskeyInput): Promise<{
    acceptance: InvoiceShareAcceptanceRow;
    bundle: InvoiceAcceptanceEvidenceBundle | null;
    created: boolean;
  }> {
    const verified = await this.options.shares.loadDocument(input.token, false);
    const existing = this.options.acceptances.findByShareId(verified.share.id);
    if (existing) return { acceptance: existing, bundle: this.bundleOf(existing), created: false };
    const contactId = verified.share.recipient_id;
    if (!contactId) throw new InvoicePasskeyAcceptanceError("recipient_required", "registered recipient is required", 400);
    const now = this.now();
    const challenge = this.consumeChallenge({
      token: input.token,
      shareId: verified.share.id,
      challengeId: input.challengeId,
      purpose: "assert",
      clientDataJsonB64url: input.response.response.clientDataJSON,
      now,
    });
    const statementJson = challenge.statementJson;
    const statement = statementJson ? parseStatement(statementJson) : null;
    if (!statementJson || !statement || challengeOf(statementJson) !== challenge.expectedChallenge) {
      throw new InvoicePasskeyAcceptanceError("invalid_challenge", "acceptance statement is invalid", 400);
    }
    if (!statementMatches(statement, {
      shareId: verified.share.id,
      documentSha256: verified.share.document_sha256,
      agreementVersion: INVOICE_AGREEMENT_VERSION,
    })) {
      throw new InvoicePasskeyAcceptanceError("invalid_challenge", "acceptance statement does not match the document", 400);
    }
    const passkey = this.options.passkeys.findActiveByCredentialId(input.response.id);
    const recipientEmailSha256 = recipientEmailSha256Of(verified.share.recipient_email);
    if (
      !passkey
      || passkey.contact_id !== contactId
      || !recipientEmailSha256
      || passkey.recipient_email_sha256 !== recipientEmailSha256
    ) {
      throw new InvoicePasskeyAcceptanceError("unknown_credential", "passkey is not registered for this recipient", 404);
    }
    let result;
    try {
      result = await this.options.webauthn.verifyAssertion({
        response: input.response,
        expectedChallenge: challenge.expectedChallenge,
        passkey: {
          credentialId: passkey.credential_id,
          publicKeyCose: passkey.public_key_cose,
          signCount: passkey.sign_count,
          transports: passkey.transports ? JSON.parse(passkey.transports) as string[] : null,
        },
      });
    } catch (error) {
      throw mapPasskeyError(error);
    }
    this.options.passkeys.updateSignCount(passkey.id, result.newSignCount);

    const cfRay = safeCfRay(input.cfRay);
    const locationSignal = evaluateAcceptanceLocation(
      input.visitorLocation,
      this.options.locationReference ?? null,
      cfRay,
      input.cloudflareClientAddress,
    );
    const clientDataJson = Buffer.from(input.response.response.clientDataJSON, "base64url").toString("utf8");
    const acceptanceId = this.idFactory();
    const evidenceDigestPayload = buildEvidenceDigestPayload({
      statementJson,
      clientDataJson,
      authenticatorDataB64url: input.response.response.authenticatorData,
      signatureB64url: input.response.response.signature,
      credentialId: passkey.credential_id,
      credentialAlgorithm: passkey.algorithm,
      publicKeyCoseB64url: passkey.public_key_cose,
      publicKeySha256: passkey.public_key_sha256,
      acceptanceId,
      shareId: verified.share.id,
      invoiceId: verified.invoice.id,
      acceptedAt: now,
      documentSha256: verified.share.document_sha256,
      agreementVersion: INVOICE_AGREEMENT_VERSION,
      agreementText: INVOICE_AGREEMENT_TEXT,
    });
    const evidence = {
      shareId: verified.share.id,
      invoiceId: verified.invoice.id,
      recipientCompany: verified.share.recipient_company,
      recipientEmail: verified.share.recipient_email,
      documentSha256: verified.share.document_sha256,
      agreementVersion: INVOICE_AGREEMENT_VERSION,
      agreementText: INVOICE_AGREEMENT_TEXT,
      acceptedAt: now,
      cfRay,
      userAgentSha256: sha256Hex((input.userAgent ?? "").slice(0, 2048)),
      authenticationMethod: "passkey" as const,
      challengeId: challenge.id,
      locationSource: locationSignal.source,
      locationCountryCode: locationSignal.countryCode,
      locationRegionCode: locationSignal.regionCode,
      issuerReferenceProximity: locationSignal.issuerReferenceProximity,
      passkey: {
        passkeyId: passkey.id,
        credentialId: passkey.credential_id,
        statementJson,
        clientDataJson,
        authenticatorDataB64url: input.response.response.authenticatorData,
        assertionSignatureB64url: input.response.response.signature,
        publicKeySha256: passkey.public_key_sha256,
      },
    };
    const recorded = this.options.acceptances.record({
      id: acceptanceId,
      ...evidence,
      evidenceSha256: evidenceSha256OfPayload(evidenceDigestPayload),
      timestampStatus: this.options.timestamps.enabled ? "pending" : "skipped",
      timestampAuthority: this.options.timestamps.authorityUrl,
    });
    if (!recorded.created) {
      return { acceptance: recorded.acceptance, bundle: this.bundleOf(recorded.acceptance), created: false };
    }
    const acceptance = recorded.acceptance;
    // 合意は確定済み。 以降 (タイムスタンプ・控えメール) の失敗は合意を取り消さない。
    await this.options.timestamps.attach(acceptance);
    const refreshed = this.options.acceptances.findByShareId(verified.share.id) ?? acceptance;
    const bundle = this.bundleOf(refreshed);
    if (bundle) {
      await this.options.evidenceMailer.send({
        to: refreshed.recipient_email,
        recipientCompany: refreshed.recipient_company,
        shareId: refreshed.share_id,
        bundle,
        evidenceUrl: this.evidenceUrl(input.token),
      });
    }
    return { acceptance: refreshed, bundle, created: true };
  }

  /** リンク所持者向け。 合意済みでなければ null。 */
  async evidenceForToken(token: string): Promise<InvoiceAcceptanceEvidenceBundle | null> {
    const verified = await this.options.shares.findPublic(token, false);
    const acceptance = this.options.acceptances.findByShareId(verified.share.id);
    return acceptance ? this.bundleOf(acceptance) : null;
  }

  /** 発行者向け。 share id から直接。 */
  evidenceForShare(shareId: string): InvoiceAcceptanceEvidenceBundle | null {
    const acceptance = this.options.acceptances.findByShareId(shareId);
    return acceptance ? this.bundleOf(acceptance) : null;
  }

  // ---- 内部 --------------------------------------------------------------------

  private bundleOf(acceptance: InvoiceShareAcceptanceRow): InvoiceAcceptanceEvidenceBundle | null {
    if (!acceptance.passkey_id) return null;
    const passkey = this.options.passkeys.find(acceptance.passkey_id);
    return passkey ? buildEvidenceBundle(acceptance, passkey) : null;
  }

  private evidenceUrl(token: string): string {
    const origin = this.options.publicUrl?.trim().replace(/\/+$/, "") ?? "";
    return `${origin}/v1/invoices/share/${encodeURIComponent(token)}?view=evidence`;
  }

  private assertNotAccepted(shareId: string): void {
    if (this.options.acceptances.findByShareId(shareId)) {
      throw new InvoicePasskeyAcceptanceError("already_accepted", "invoice share is already accepted", 409);
    }
  }

  private issueChallenge(input: {
    token: string;
    shareId: string;
    purpose: "register" | "assert";
    challenge: string;
    statementJson: string | null;
    enrollmentGrantId: string | null;
    now: number;
  }): string {
    if (this.options.challenges.countForShare(input.shareId) >= MAX_CHALLENGES_PER_SHARE) {
      throw new InvoicePasskeyAcceptanceError("locked", "passkey challenge limit reached for this share", 429);
    }
    const id = this.idFactory();
    this.options.challenges.insert({
      id,
      shareId: input.shareId,
      purpose: input.purpose,
      statementJson: input.statementJson,
      challengeHash: webauthnChallengeHash(input.token, id, input.challenge),
      enrollmentGrantId: input.enrollmentGrantId,
      createdAt: input.now,
      expiresAt: input.now + CHALLENGE_TTL_SECONDS,
    });
    return id;
  }

  /**
   * clientDataJSON の challenge を取り出し、 保存済み HMAC と照合してから 1 回だけ消費する。
   * 返す expectedChallenge は simplewebauthn へそのまま渡す (署名がこの値を覆っていることを検証させる)。
   */
  private consumeChallenge(input: {
    token: string;
    shareId: string;
    challengeId: string;
    purpose: "register" | "assert";
    clientDataJsonB64url: string;
    now: number;
  }): { id: string; expectedChallenge: string; statementJson: string | null; enrollment_grant_id: string | null } {
    if (!/^[0-9a-f-]{36}$/i.test(input.challengeId)) {
      throw new InvoicePasskeyAcceptanceError("invalid_challenge", "challenge id is invalid", 400);
    }
    const row = this.options.challenges.find(input.challengeId);
    if (!row || row.share_id !== input.shareId || row.purpose !== input.purpose || row.consumed_at !== null) {
      throw new InvoicePasskeyAcceptanceError("invalid_challenge", "challenge is invalid", 400);
    }
    if (row.expires_at < input.now) {
      throw new InvoicePasskeyAcceptanceError("expired", "challenge has expired", 410);
    }
    let presented: string;
    try {
      presented = decodeClientDataJSON(input.clientDataJsonB64url).challenge;
    } catch {
      throw new InvoicePasskeyAcceptanceError("verification_failed", "clientDataJSON is malformed", 400);
    }
    if (typeof presented !== "string" || presented.length === 0 || presented.length > 512) {
      throw new InvoicePasskeyAcceptanceError("verification_failed", "clientDataJSON challenge is malformed", 400);
    }
    const expected = Buffer.from(row.challenge_hash, "hex");
    const actual = Buffer.from(webauthnChallengeHash(input.token, row.id, presented), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new InvoicePasskeyAcceptanceError("invalid_challenge", "challenge does not match", 400);
    }
    if (!this.options.challenges.consume(row.id, input.now)) {
      throw new InvoicePasskeyAcceptanceError("invalid_challenge", "challenge was already used", 400);
    }
    return {
      id: row.id,
      expectedChallenge: presented,
      statementJson: row.statement_json,
      enrollment_grant_id: row.enrollment_grant_id,
    };
  }
}

function webauthnChallengeHash(token: string, challengeId: string, challenge: string): string {
  return createHmac("sha256", token).update(`webauthn:${challengeId}:${challenge}`).digest("hex");
}

function mapPasskeyError(error: unknown): Error {
  if (error instanceof InvoicePasskeyError && error.code === "verification_failed") {
    return new InvoicePasskeyAcceptanceError("verification_failed", error.message, 400);
  }
  return error instanceof Error ? error : new Error("passkey verification failed");
}

function safeCfRay(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && /^[A-Za-z0-9-]{1,100}$/.test(candidate) ? candidate : null;
}

function recipientEmailSha256Of(value: string | null): string | null {
  const email = value?.trim().toLowerCase();
  return email ? sha256Hex(email) : null;
}
