/**
 * 公開マジックリンク配下のパスキー用ブラウザスクリプト配信。
 * `invoice-shares.ts` と同じ `/v1/invoices` にマウントする。 公開ヘッダーとレート制限は
 * app.ts が `invoiceSharePublicGuard` で `/v1/invoices/share/*` に 1 回だけ掛ける。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-006 (spec/feature/invoice-public-magic-link.md)
 */

import { Hono } from "hono";
import { INVOICE_SHARE_PASSKEY_SCRIPT } from "../invoices/invoice-share-passkey-script.js";

export function invoiceSharePasskeysRouter(): Hono {
  const app = new Hono();

  // 公開面を増やさないよう、ブラウザ資産は `share/` 直下のこの 1 本だけに固定する。
  // `/share/:token` より前に登録することで token として解釈されるのを防ぐ。
  app.get("/share/passkey.js", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(INVOICE_SHARE_PASSKEY_SCRIPT);
  });

  return app;
}
