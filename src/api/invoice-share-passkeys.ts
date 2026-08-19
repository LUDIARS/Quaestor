/**
 * 公開マジックリンク配下のパスキー API (JSON) と証跡バンドル取得、 ブラウザスクリプト配信。
 * `invoice-shares.ts` と同じ `/v1/invoices` にマウントする。 公開ヘッダーとレート制限は
 * app.ts が `invoiceSharePublicGuard` で `/v1/invoices/share/*` に 1 回だけ掛ける。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-006 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-007 (spec/feature/invoice-public-magic-link.md)
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { INVOICE_SHARE_PASSKEY_SCRIPT } from "../invoices/invoice-share-passkey-script.js";
import {
  InvoicePasskeyAcceptanceError,
  type InvoiceSharePasskeyAcceptanceService,
} from "../services/invoice-share-passkey-acceptance-service.js";
import { InvoicePasskeyError } from "../services/invoice-passkey-service.js";
import { InvoiceShareError } from "../services/invoice-share-service.js";
import { evidenceBundleFilename } from "../services/invoice-acceptance-evidence-bundle.js";
import { rejectCrossSite, visitorLocation } from "./invoice-share-public-guard.js";

const OptionsSchema = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("register"), grant_id: z.string().uuid() }).strict(),
  z.object({ purpose: z.literal("assert") }).strict(),
]);

/** ブラウザが返す PublicKeyCredential JSON。 内容の妥当性は simplewebauthn が検証する。 */
const CredentialResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  clientExtensionResults: z.record(z.unknown()).default({}),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  response: z.record(z.unknown()),
}).passthrough();

const RegisterSchema = z.object({
  grant_id: z.string().uuid(),
  challenge_id: z.string().uuid(),
  response: CredentialResponseSchema,
}).strict();

const AcceptSchema = z.object({
  challenge_id: z.string().uuid(),
  response: CredentialResponseSchema,
}).strict();

const MAX_JSON_BYTES = 64 * 1024;

export function invoiceSharePasskeysRouter(deps: {
  service: InvoiceSharePasskeyAcceptanceService;
}): Hono {
  const app = new Hono();

  app.get("/share/assets/passkey.js", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(INVOICE_SHARE_PASSKEY_SCRIPT);
  });

  app.post("/share/:token/passkey/options", async (c) => {
    if (rejectCrossSite(c)) return c.json({ error: "forbidden" }, 403);
    const parsed = OptionsSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const token = c.req.param("token");
    try {
      if (parsed.data.purpose === "register") {
        const result = await deps.service.registrationOptions({ token, grantId: parsed.data.grant_id });
        return c.json({ challenge_id: result.challengeId, options: result.options });
      }
      const result = await deps.service.assertionOptions({ token });
      return c.json({ challenge_id: result.challengeId, options: result.options, statement: result.statement });
    } catch (error) {
      return passkeyError(c, error);
    }
  });

  app.post("/share/:token/passkey/register", async (c) => {
    if (rejectCrossSite(c)) return c.json({ error: "forbidden" }, 403);
    const parsed = RegisterSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    try {
      const result = await deps.service.register({
        token: c.req.param("token"),
        grantId: parsed.data.grant_id,
        challengeId: parsed.data.challenge_id,
        response: parsed.data.response as never,
      });
      return c.json({ ok: true, passkey_id: result.passkeyId, public_key_sha256: result.publicKeySha256 }, 201);
    } catch (error) {
      return passkeyError(c, error);
    }
  });

  app.post("/share/:token/passkey/accept", async (c) => {
    if (rejectCrossSite(c)) return c.json({ error: "forbidden" }, 403);
    const parsed = AcceptSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    try {
      const result = await deps.service.accept({
        token: c.req.param("token"),
        challengeId: parsed.data.challenge_id,
        response: parsed.data.response as never,
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
    } catch (error) {
      return passkeyError(c, error);
    }
  });

  app.get("/share/:token/evidence.json", async (c) => {
    try {
      const bundle = await deps.service.evidenceForToken(c.req.param("token"));
      if (!bundle) return c.json({ error: "not_found" }, 404);
      c.header("Content-Disposition", `attachment; filename="${evidenceBundleFilename(bundle.acceptance.share_id)}"`);
      return c.json(bundle);
    } catch (error) {
      return passkeyError(c, error);
    }
  });

  return app;
}

async function readJson(c: Context): Promise<unknown> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) return null;
  const text = await c.req.text().catch(() => "");
  if (text.length > MAX_JSON_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function passkeyError(c: Context, error: unknown) {
  if (error instanceof InvoicePasskeyAcceptanceError) {
    return c.json({ error: error.code, message: publicMessage(error.code) }, error.status);
  }
  if (error instanceof InvoicePasskeyError) {
    return c.json({ error: error.code, message: publicMessage(error.code) }, error.status);
  }
  if (error instanceof InvoiceShareError && error.code === "document_changed") {
    return c.json({ error: "document_changed", message: "請求書が発行時から変更されているため合意できません。" }, 409);
  }
  return c.json({ error: "not_found" }, 404);
}

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
