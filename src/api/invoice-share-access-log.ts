/**
 * 公開マジックリンク経路 (`/v1/invoices/share/*`) の詳細アクセスログ。
 *
 * なぜ必要か:
 *   この経路は Cloudflare → cloudflared → Quaestor と 3 段を挟むため、
 *   「利用者の画面で動かない」 とき **サーバまで届いているのかどうか** が
 *   分からないと切り分けが始まらない。 実際 2026-09-01 に、 Cloudflare 側で
 *   404 になっていたスクリプトと API を、 サーバログが無いために往復して
 *   突き止める羽目になった。 到達したリクエストを全部記録して、 次からは
 *   ログ 1 本で 「届いていない」 と言い切れるようにする。
 *
 * これは調査用の一時ログで、 安定後に撤去する (prefix `[verbose-invoice-share]`
 * で全箇所を grep できる)。
 *
 * @implements SPEC-INVOICE-ACCESS-003 (spec/feature/invoice-public-magic-link.md)
 *
 * 出さないもの: token 本体、 client address、 User-Agent、 メールアドレス、
 * PDF の中身、 WebAuthn の署名、 例外メッセージ。
 * リクエスト由来の識別子は短いハッシュだけを出して、 同一リクエスト元の追跡だけを可能にする。
 */

import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { clientAddress } from "./invoice-share-public-guard.js";

export const VERBOSE_INVOICE_SHARE = "[verbose-invoice-share]";

export interface ShareAccessLogger {
  /** pino を渡せば info が使われる。 warn しか持たない呼び出し元でも落とさない。 */
  info?(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
}

/** token を追跡可能な短いハッシュへ畳む。 token 本体はログに出さない。 */
export function tokenFingerprint(token: string | undefined): string {
  if (!token) return "none";
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * 公開経路のリクエストを入口と出口の 2 行で記録する。
 * 出口の行が無ければ 「途中で落ちた」 と判断できる (サイレント死の検知)。
 */
export function invoiceShareAccessLog(logger: ShareAccessLogger | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!logger) return next();
    const write = (fields: Record<string, unknown>, message: string): void => {
      if (logger.info) logger.info(fields, message);
      else logger.warn(fields, message);
    };
    const startedAt = Date.now();
    const pathname = new URL(c.req.url).pathname;
    // ミドルウェア段階ではルートが未解決で c.req.param("token") が取れないため、
    // パスから直接取り出す。
    const token = tokenFromPath(pathname);
    const base = {
      method: c.req.method,
      // token はパスの一部なので、 pathname をそのまま出すと生 token が漏れる。
      // 指紋へ置換してから記録する。
      path: maskToken(pathname, token),
      token: tokenFingerprint(token),
      client: requestMetadataFingerprint(clientAddress(c)),
      // Cloudflare を経由したかどうかは、 到達しない問題の切り分けで最初に見る。
      via_cloudflare: !!c.req.header("CF-Connecting-IP"),
      user_agent: requestMetadataFingerprint(c.req.header("User-Agent")),
    };
    write(base, `${VERBOSE_INVOICE_SHARE} request`);
    try {
      await next();
    } catch (error) {
      logger.warn(
        // 下流例外の本文には token、 メールアドレス、 provider 応答等が入り得るため記録しない。
        { ...base, elapsed_ms: Date.now() - startedAt },
        `${VERBOSE_INVOICE_SHARE} request threw`,
      );
      throw error;
    }
    write(
      { ...base, status: c.res.status, elapsed_ms: Date.now() - startedAt },
      `${VERBOSE_INVOICE_SHARE} response`,
    );
  };
}

/** 公開経路のプレフィクス。 この直下 1 セグメントが token。 */
const SHARE_PREFIX = "/v1/invoices/share/";
const PASSKEY_SCRIPT_PATH = `${SHARE_PREFIX}passkey.js`;
const KNOWN_TOKEN_PATH_SUFFIXES = new Set([
  "",
  "/document.pdf",
  "/accept",
  "/accept/confirm",
  "/passkey/options",
  "/passkey/register",
  "/passkey/accept",
  "/evidence.json",
]);

/** パスから token セグメントを取り出す。 token を持たない配信パスは undefined。 */
export function tokenFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(SHARE_PREFIX)) return undefined;
  if (pathname === PASSKEY_SCRIPT_PATH) return undefined;
  const segment = pathname.slice(SHARE_PREFIX.length).split("/")[0];
  if (!segment) return undefined;
  return segment;
}

/** token と未知 suffix を指紋へ置換する。既知の公開 API ルートだけは切り分け用に残す。 */
function maskToken(pathname: string, token: string | undefined): string {
  if (!token) return pathname;
  const suffix = pathname.slice(SHARE_PREFIX.length + token.length);
  const maskedToken = `<token:${tokenFingerprint(token)}>`;
  if (KNOWN_TOKEN_PATH_SUFFIXES.has(suffix)) return `${SHARE_PREFIX}${maskedToken}${suffix}`;
  return `${SHARE_PREFIX}${maskedToken}/<path:${requestMetadataFingerprint(suffix)}>`;
}

/** 生の client address / User-Agent を永続化せず、 リクエスト元の相関だけを可能にする。 */
function requestMetadataFingerprint(value: string | undefined): string {
  if (!value) return "none";
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
