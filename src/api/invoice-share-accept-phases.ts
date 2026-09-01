/**
 * 公開合意フローのフェーズ処理。
 *
 * なぜ 1 つのパスに集約するのか:
 *   公開経路 (`qs-magiclink`) の前段は `/v1/invoices/share/<token>` と
 *   `/v1/invoices/share/<token>/accept` しか通さない。 パスを増やすと Cloudflare 側で
 *   404 になり、 ページは出るのに操作だけ無反応という無言の故障になる (2026-09-01)。
 *   公開面を増やさないため、 パスキーの各段階も同じ `/accept` に載せ、 JSON body の
 *   `phase` で分岐する。 公開してよい面をコード側で固定できる利点もある。
 *
 * OTP フェーズ (form-urlencoded) は `invoice-shares.ts` が扱う。 ここは JSON body の
 * パスキーフェーズだけを担当する。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-006 (spec/feature/invoice-public-magic-link.md)
 */

import type { Context } from "hono";
import { z } from "zod";
import {
  InvoicePasskeyAcceptanceError,
  type InvoiceSharePasskeyAcceptanceService,
} from "../services/invoice-share-passkey-acceptance-service.js";
import {
  InvoicePasskeyError,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "../services/invoice-passkey-service.js";
import { InvoiceShareError } from "../services/invoice-share-service.js";
import { visitorLocation } from "./invoice-share-public-guard.js";

/** ブラウザが返す PublicKeyCredential JSON。 内容の妥当性は simplewebauthn が検証する。 */
const CredentialResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  clientExtensionResults: z.record(z.unknown()).default({}),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  response: z.record(z.unknown()),
}).passthrough();

/** `/accept` に載る JSON フェーズ。 form-urlencoded の OTP フェーズとは排他。 */
/** 登録用は grant_id 必須、 署名用は不要。 purpose で判別する。 */
const OptionsPhaseSchema = z.discriminatedUnion("purpose", [
  z.object({ phase: z.literal("passkey-options"), purpose: z.literal("register"), grant_id: z.string().uuid() }).strict(),
  z.object({ phase: z.literal("passkey-options"), purpose: z.literal("assert") }).strict(),
]);

const RegisterPhaseSchema = z.object({
  phase: z.literal("passkey-register"),
  grant_id: z.string().uuid(),
  challenge_id: z.string().uuid(),
  response: CredentialResponseSchema,
}).strict();

const AcceptPhaseSchema = z.object({
  phase: z.literal("passkey-accept"),
  challenge_id: z.string().uuid(),
  response: CredentialResponseSchema,
}).strict();

// phase は 3 値だが passkey-options が purpose で 2 分岐するため、 discriminatedUnion
// を入れ子にする (同じ discriminator 値を 2 つ並べると zod が受け付けない)。
const PasskeyPhaseSchema = z.union([
  OptionsPhaseSchema,
  RegisterPhaseSchema,
  AcceptPhaseSchema,
]);

const MAX_JSON_BYTES = 64 * 1024;

export interface PasskeyPhaseDeps {
  passkeyAcceptances: InvoiceSharePasskeyAcceptanceService;
}

/**
 * JSON body を上限付きで読む。 上限超過と壊れた JSON はどちらも null にして、
 * 呼び出し側が invalid_request として扱えるようにする。
 */
export async function readJsonBody(c: Context): Promise<unknown> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) return null;
  const text = await c.req.text().catch(() => "");
  // JS の string.length は UTF-16 code unit 数なので、非 ASCII 入力は UTF-8 実バイト数で判定する。
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Content-Type が JSON なら パスキーフェーズ、 それ以外は OTP フェーズ。 */
export function isPasskeyPhaseRequest(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().includes("application/json");
}

/** パスキーフェーズを処理する。 body は呼び出し側が読み込み済みのものを渡す。 */
export async function handlePasskeyPhase(
  c: Context,
  body: unknown,
  deps: PasskeyPhaseDeps,
): Promise<Response> {
  const parsed = PasskeyPhaseSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  // 呼び出し元は `/share/:token/accept` に載せるので token は必ず取れるが、
  // 型上は optional なので明示的に弾く (空文字でサービスへ渡さない)。
  const token = c.req.param("token");
  if (!token) return c.json({ error: "invalid_request" }, 400);
  try {
    switch (parsed.data.phase) {
      case "passkey-options": {
        if (parsed.data.purpose === "register") {
          const result = await deps.passkeyAcceptances.registrationOptions({
            token,
            grantId: parsed.data.grant_id,
          });
          return c.json({ challenge_id: result.challengeId, options: result.options });
        }
        const result = await deps.passkeyAcceptances.assertionOptions({ token });
        return c.json({
          challenge_id: result.challengeId,
          options: result.options,
          statement: result.statement,
        });
      }
      case "passkey-register": {
        const result = await deps.passkeyAcceptances.register({
          token,
          grantId: parsed.data.grant_id,
          challengeId: parsed.data.challenge_id,
          response: parsed.data.response as unknown as RegistrationResponseJSON,
        });
        return c.json(
          { ok: true, passkey_id: result.passkeyId, public_key_sha256: result.publicKeySha256 },
          201,
        );
      }
      case "passkey-accept": {
        const result = await deps.passkeyAcceptances.accept({
          token,
          challengeId: parsed.data.challenge_id,
          response: parsed.data.response as unknown as AuthenticationResponseJSON,
          cfRay: c.req.header("CF-Ray"),
          userAgent: c.req.header("user-agent"),
          cloudflareClientAddress: c.req.header("CF-Connecting-IP"),
          visitorLocation: visitorLocation(c),
        });
        return c.json({
          ok: true,
          accepted_at: result.acceptance.accepted_at,
          evidence_sha256: result.acceptance.evidence_sha256,
          timestamp_status: result.acceptance.timestamp_status,
        }, result.created ? 201 : 200);
      }
    }
  } catch (error) {
    return passkeyPhaseError(c, error);
  }
}

/** 公開経路に返す誤り。 内部の詳細は出さない。 */
function passkeyPhaseError(c: Context, error: unknown): Response {
  if (error instanceof InvoicePasskeyAcceptanceError) {
    return c.json({ error: error.code, message: publicMessage(error.code) }, error.status);
  }
  if (error instanceof InvoicePasskeyError) {
    return c.json({ error: error.code, message: publicMessage(error.code) }, error.status);
  }
  if (error instanceof InvoiceShareError && error.code === "document_changed") {
    return c.json({
      error: "document_changed",
      message: "請求書が発行時から変更されているため合意できません。",
    }, 409);
  }
  // 無効リンクの理由やサービス内部の例外詳細を公開面へ出さない。
  if (error instanceof InvoiceShareError) return c.json({ error: "not_found" }, 404);
  return c.json({ error: "passkey_failed", message: publicMessage("passkey_failed") }, 500);
}

/** ブラウザに表示しても内部情報を漏らさない固定メッセージ。 */
function publicMessage(code: string): string {
  switch (code) {
    case "already_accepted": return "この請求は既に合意済みです。";
    case "no_passkey": return "パスキーが登録されていません。メール確認から登録してください。";
    case "invalid_grant": return "登録許可が無効または期限切れです。請求書ページからやり直してください。";
    case "expired": return "署名の有効期限が切れました。もう一度お試しください。";
    case "locked": return "試行回数の上限に達しました。送信元へご連絡ください。";
    case "unknown_credential": return "このパスキーは登録されていません。";
    case "verification_failed": return "署名を検証できませんでした。もう一度お試しください。";
    case "not_configured": return "パスキー機能が設定されていません。";
    case "recipient_required": return "このリンクは送信先台帳に紐づいていません。";
    default: return "処理できませんでした。もう一度お試しください。";
  }
}
