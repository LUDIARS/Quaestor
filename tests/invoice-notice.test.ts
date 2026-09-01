import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInvoiceNotice } from "../src/services/invoice-notice.js";
import { NotificationService } from "../src/services/notification-service.js";
import { NotificationState } from "../src/services/notification-state.js";
import type { DiscordMessage, DiscordNotifier } from "../src/services/discord-notifier.js";
import type { InvoiceRow } from "../src/db/invoices-repo.js";

let counter = 0;
const tmpState = () => join(tmpdir(), `quaestor-invoice-notify-${process.pid}-${++counter}.json`);

function fakeNotifier(): DiscordNotifier & { sent: DiscordMessage[] } {
  const sent: DiscordMessage[] = [];
  return { enabled: true, sent, async send(m) { sent.push(m); return true; } };
}

const invoice = (over: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: 40,
  issued_at: "2026-08-31",
  due_date: "2026-10-01",
  client: "サンプル株式会社",
  work_summary: "システム開発業務 2026年8月分",
  amount: 110000,
  withholding_tax: 10210,
  status: "draft",
  transaction_id: null,
  notes: null,
  metadata: null,
  created_at: 0,
  updated_at: 100,
  ...over,
});

function fieldValue(message: DiscordMessage, name: string): string | undefined {
  return message.embeds?.[0]?.fields?.find((f) => f.name === name)?.value;
}

describe("buildInvoiceNotice", () => {
  it("源泉があるときは差引後だと分かる内訳を出す", () => {
    const built = buildInvoiceNotice(invoice());
    expect(built.hasContent).toBe(true);
    expect(fieldValue(built.message, "請求額")).toBe("¥99,790 (税込 ¥110,000 − 源泉 ¥10,210)");
  });

  it("源泉が無いときは金額だけを出す", () => {
    const built = buildInvoiceNotice(invoice({ withholding_tax: 0 }));
    expect(fieldValue(built.message, "請求額")).toBe("¥110,000");
  });

  it("metadata の invoice_no をタイトルに使い、無ければ id で出す", () => {
    const withNo = buildInvoiceNotice(invoice({ metadata: JSON.stringify({ invoice_no: 91 }) }));
    expect(withNo.message.embeds?.[0]?.title).toBe("🧾 請求書 No.91");
    expect(buildInvoiceNotice(invoice()).message.embeds?.[0]?.title).toBe("🧾 請求書 #40");
  });

  it("metadata が壊れていても通知を止めない", () => {
    const built = buildInvoiceNotice(invoice({ metadata: "{壊れ" }));
    expect(built.hasContent).toBe(true);
    expect(built.message.embeds?.[0]?.title).toBe("🧾 請求書 #40");
  });

  it("metadata が null や配列の JSON でも通知を止めない", () => {
    for (const metadata of ["null", "[]"]) {
      const built = buildInvoiceNotice(invoice({ metadata }));
      expect(built.message.embeds?.[0]?.title).toBe("🧾 請求書 #40");
    }
  });

  it("状態は日本語で出し、備考は有るときだけ載せる", () => {
    const paid = buildInvoiceNotice(invoice({ status: "paid", notes: "口座変更あり" }));
    expect(fieldValue(paid.message, "状態")).toBe("入金済み");
    expect(fieldValue(paid.message, "備考")).toBe("口座変更あり");
    expect(fieldValue(buildInvoiceNotice(invoice()).message, "備考")).toBeUndefined();
  });

  it("dedupKey は状態遷移で変わる (同じ請求書でも再通知したい)", () => {
    const a = buildInvoiceNotice(invoice({ status: "draft" })).dedupKey;
    const b = buildInvoiceNotice(invoice({ status: "sent" })).dedupKey;
    expect(a).not.toBe(b);
  });
});

describe("NotificationService.notifyInvoice", () => {
  function make(notifier: DiscordNotifier, find: (id: number) => InvoiceRow | null) {
    return new NotificationService({
      notifier,
      state: new NotificationState(tmpState()),
      investSuggestions: () => [],
      dividendCandidates: () => [],
      subsidySuggest: async () => ({ planName: "P", suggestions: [] }),
      findInvoice: find,
    });
  }

  it("存在する請求書を送る", async () => {
    const n = fakeNotifier();
    const result = await make(n, () => invoice()).notifyInvoice(40);
    expect(result.sent).toBe(true);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0].embeds?.[0]?.footer?.text).toBe("Quaestor invoice id=40");
  });

  it("存在しない id は送らず not_found を返す", async () => {
    const n = fakeNotifier();
    const result = await make(n, () => null).notifyInvoice(999);
    expect(result.sent).toBe(false);
    expect(result.notFound).toBe(true);
    expect(result.reason).toBe("invoice not_found");
    expect(n.sent).toHaveLength(0);
  });

  it("webhook 未設定なら disabled を返して送らない", async () => {
    const off: DiscordNotifier = { enabled: false, async send() { return false; } };
    const result = await make(off, () => invoice()).notifyInvoice(40);
    expect(result.sent).toBe(false);
    expect(result.disabled).toBe(true);
  });

  it("dedup 指定なら同内容の再送を抑える", async () => {
    const n = fakeNotifier();
    const svc = make(n, () => invoice());
    expect((await svc.notifyInvoice(40, { dedup: true })).sent).toBe(true);
    expect((await svc.notifyInvoice(40, { dedup: true })).skipped).toBe(true);
    expect(n.sent).toHaveLength(1);
  });
});
