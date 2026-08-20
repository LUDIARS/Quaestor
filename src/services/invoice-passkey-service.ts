/**
 * WebAuthn (パスキー) の options 生成と応答検証。 `@simplewebauthn/server` の薄いラッパで、
 * RP ID / origin は `invoiceShare.publicUrl` から導出する。 DB もメールも知らない。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-006 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  cose,
  decodeCredentialPublicKey,
  isoBase64URL,
} from "@simplewebauthn/server/helpers";

export type { AuthenticationResponseJSON, RegistrationResponseJSON };

/** 署名アルゴリズムは ES256 / RS256 に限定 (Ed25519 はブラウザ実装差が大きい)。 */
const SUPPORTED_ALGORITHMS = [-7, -257];
const PASSKEY_TIMEOUT_MS = 5 * 60 * 1000;

export class InvoicePasskeyError extends Error {
  constructor(
    readonly code: "not_configured" | "verification_failed",
    message: string,
    readonly status: 400 | 503,
  ) {
    super(message);
  }
}

export interface RegisteredPasskey {
  credentialId: string;
  publicKeyCose: string;
  publicKeySha256: string;
  algorithm: number;
  signCount: number;
  transports: string[] | null;
  aaguid: string | null;
}

export interface StoredPasskey {
  credentialId: string;
  publicKeyCose: string;
  signCount: number;
  transports: string[] | null;
}

export interface InvoicePasskeyServiceOptions {
  /** `https://qs-magiclink.example` のような公開 origin。 未設定なら 503。 */
  publicUrl?: string;
  rpName?: string;
  /** ローカルテストモード限定: `http://localhost[:port]` を RP origin として許可する。 */
  allowLocalHttpOrigin?: boolean;
}

export class InvoicePasskeyService {
  private readonly origin: string | null;
  private readonly rpId: string | null;
  private readonly rpName: string;

  constructor(options: InvoicePasskeyServiceOptions) {
    const parsed = parseOrigin(options.publicUrl, options.allowLocalHttpOrigin === true);
    this.origin = parsed?.origin ?? null;
    this.rpId = parsed?.hostname ?? null;
    this.rpName = options.rpName ?? "Quaestor 請求書";
  }

  async registrationOptions(input: {
    challenge: Buffer;
    userName: string;
    userDisplayName: string;
    excludeCredentialIds: string[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const rp = this.requireRp();
    return generateRegistrationOptions({
      rpName: this.rpName,
      rpID: rp.rpId,
      userName: input.userName,
      userDisplayName: input.userDisplayName,
      challenge: toUint8Array(input.challenge),
      timeout: PASSKEY_TIMEOUT_MS,
      attestationType: "none",
      excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    });
  }

  async verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
  }): Promise<RegisteredPasskey> {
    const rp = this.requireRp();
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
      });
    } catch {
      throw new InvoicePasskeyError("verification_failed", "passkey registration could not be verified", 400);
    }
    if (!verified.verified) {
      throw new InvoicePasskeyError("verification_failed", "passkey registration could not be verified", 400);
    }
    const { credential, aaguid } = verified.registrationInfo;
    const publicKeyCose = isoBase64URL.fromBuffer(credential.publicKey);
    return {
      credentialId: credential.id,
      publicKeyCose,
      publicKeySha256: publicKeyFingerprint(publicKeyCose),
      algorithm: algorithmOf(credential.publicKey),
      signCount: credential.counter,
      transports: credential.transports ?? null,
      aaguid: aaguid && aaguid !== "00000000-0000-0000-0000-000000000000" ? aaguid : null,
    };
  }

  async authenticationOptions(input: {
    challenge: Buffer;
    allowCredentials: { id: string; transports: string[] | null }[];
  }): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const rp = this.requireRp();
    return generateAuthenticationOptions({
      rpID: rp.rpId,
      challenge: toUint8Array(input.challenge),
      timeout: PASSKEY_TIMEOUT_MS,
      userVerification: "required",
      allowCredentials: input.allowCredentials.map((credential) => ({
        id: credential.id,
        transports: (credential.transports ?? undefined) as never,
      })),
    });
  }

  /** 署名検証。 成功時は認証器カウンタの新値を返す (後退は simplewebauthn が拒否する)。 */
  async verifyAssertion(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    passkey: StoredPasskey;
  }): Promise<{ newSignCount: number }> {
    const rp = this.requireRp();
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
        credential: {
          id: input.passkey.credentialId,
          publicKey: isoBase64URL.toBuffer(input.passkey.publicKeyCose),
          counter: input.passkey.signCount,
          transports: (input.passkey.transports ?? undefined) as never,
        },
      });
    } catch {
      throw new InvoicePasskeyError("verification_failed", "passkey assertion could not be verified", 400);
    }
    if (!verified.verified) {
      throw new InvoicePasskeyError("verification_failed", "passkey assertion could not be verified", 400);
    }
    return { newSignCount: verified.authenticationInfo.newCounter };
  }

  private requireRp(): { origin: string; rpId: string } {
    if (!this.origin || !this.rpId) {
      throw new InvoicePasskeyError("not_configured", "invoiceShare.publicUrl is required for passkeys", 503);
    }
    return { origin: this.origin, rpId: this.rpId };
  }
}

/** 公開鍵指紋 = SHA-256(COSE_Key bytes)。 契約書記載・管理画面表示・バンドルで同じ値を使う。 */
export function publicKeyFingerprint(publicKeyCose: string): string {
  return createHash("sha256").update(isoBase64URL.toBuffer(publicKeyCose)).digest("hex");
}

/** COSE 公開鍵 → Node の KeyObject。 SPKI/JWK 出力 (第三者検証用) に使う。 */
export function publicKeyObjectFromCose(publicKeyCose: string): KeyObject {
  const decoded = decodeCredentialPublicKey(isoBase64URL.toBuffer(publicKeyCose));
  if (cose.isCOSEPublicKeyEC2(decoded)) {
    const x = decoded.get(cose.COSEKEYS.x);
    const y = decoded.get(cose.COSEKEYS.y);
    const crv = decoded.get(cose.COSEKEYS.crv);
    if (!x || !y || crv !== cose.COSECRV.P256) throw new Error("unsupported EC2 public key");
    return createPublicKey({
      key: { kty: "EC", crv: "P-256", x: isoBase64URL.fromBuffer(x), y: isoBase64URL.fromBuffer(y) },
      format: "jwk",
    });
  }
  if (cose.isCOSEPublicKeyRSA(decoded)) {
    const n = decoded.get(cose.COSEKEYS.n);
    const e = decoded.get(cose.COSEKEYS.e);
    if (!n || !e) throw new Error("unsupported RSA public key");
    return createPublicKey({
      key: { kty: "RSA", n: isoBase64URL.fromBuffer(n), e: isoBase64URL.fromBuffer(e) },
      format: "jwk",
    });
  }
  throw new Error("unsupported COSE public key type");
}

function algorithmOf(publicKey: Uint8Array): number {
  const decoded = decodeCredentialPublicKey(toUint8Array(publicKey));
  const alg = decoded.get(cose.COSEKEYS.alg);
  return typeof alg === "number" ? alg : 0;
}

/** Buffer (ArrayBufferLike) を simplewebauthn が要求する Uint8Array<ArrayBuffer> へ複製する。 */
function toUint8Array(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function parseOrigin(
  publicUrl: string | undefined,
  allowLocalHttpOrigin: boolean,
): { origin: string; hostname: string } | null {
  const trimmed = publicUrl?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    // RP ID は登録可能ドメインが必要で IP は使えないため、 ローカルテストは localhost に限る。
    const localTestOrigin = allowLocalHttpOrigin && url.protocol === "http:" && url.hostname === "localhost";
    if (
      (url.protocol !== "https:" && !localTestOrigin)
      || !url.hostname
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return null;
    return { origin: url.origin, hostname: url.hostname };
  } catch {
    return null;
  }
}
