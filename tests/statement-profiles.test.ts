import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import iconv from "iconv-lite";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { StatementProfilesRepo, type StatementProfileRow } from "../src/db/statement-profiles-repo.js";
import { parseWithProfile, detectProfile } from "../src/importers/profile-csv.js";
import { buildApp } from "../src/app.js";

/** 楽天カード風の合成 CSV (SJIS): 利用日,店名,利用者,支払方法,利用金額,... */
function rakutenCsv(): Buffer {
  const text = [
    "利用日,利用店名,利用者,支払方法,利用金額",
    "2025/4/1,楽天市場,本人,1回,3500",
    "2025/4/8,スターバックス渋谷,本人,1回,680",
    ",,,,",
  ].join("\r\n");
  return iconv.encode(text, "Shift_JIS");
}

function makeProfile(over: Partial<StatementProfileRow> = {}): StatementProfileRow {
  return {
    id: 1, name: "楽天カード", brand: "rakuten", source: "credit-card",
    encoding: "shift_jis", header_skip: 1, col_date: 0, col_payee: 1, col_amount: 4,
    col_memo: null, amount_sign: "out", filter_col: null, filter_value: null,
    date_year_hint: null, account_default: "楽天カード", detect_keywords: null,
    enabled: 1, created_at: 0, updated_at: 0, ...over,
  };
}

describe("parseWithProfile", () => {
  it("列マップ通りに SJIS CSV をパースする", () => {
    const r = parseWithProfile(makeProfile(), rakutenCsv());
    expect(r.brand).toBe("rakuten");
    expect(r.account).toBe("楽天カード");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.date).toBe("2025-04-01");
    expect(r.rows[0]!.payee).toBe("楽天市場");
    expect(r.rows[0]!.amount_out).toBe(3500);
    expect(r.rows[0]!.amount_in).toBeNull();
  });

  it("amount_sign=signed は符号で in/out を振り分ける", () => {
    const csv = iconv.encode(["日付,店,額", "2025/4/1,A,-1000", "2025/4/2,B,500"].join("\r\n"), "Shift_JIS");
    const r = parseWithProfile(
      makeProfile({ header_skip: 1, col_date: 0, col_payee: 1, col_amount: 2, amount_sign: "signed" }),
      csv,
    );
    expect(r.rows[0]!.amount_out).toBe(1000);
    expect(r.rows[1]!.amount_in).toBe(500);
  });

  it("filter_col/value で対象行を絞る", () => {
    const csv = iconv.encode(
      ["状態,日付,店,額", "確定,2025/4/1,A,100", "保留,2025/4/2,B,200"].join("\r\n"),
      "Shift_JIS",
    );
    const r = parseWithProfile(
      makeProfile({ header_skip: 1, col_date: 1, col_payee: 2, col_amount: 3, filter_col: 0, filter_value: "確定" }),
      csv,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.payee).toBe("A");
  });

  it("source_id は同 buffer 再パースで安定", () => {
    const a = parseWithProfile(makeProfile(), rakutenCsv());
    const b = parseWithProfile(makeProfile(), rakutenCsv());
    expect(a.rows.map((r) => r.source_id)).toEqual(b.rows.map((r) => r.source_id));
  });
});

describe("detectProfile", () => {
  it("detect_keywords が本文にあれば一致", () => {
    const p = makeProfile({ detect_keywords: '["利用店名"]' });
    expect(detectProfile([p], rakutenCsv())?.brand).toBe("rakuten");
  });
  it("keywords 空のプロファイルは対象外", () => {
    expect(detectProfile([makeProfile()], rakutenCsv())).toBeNull();
  });
});

describe("API: /v1/statement-profiles CRUD + import via profile", () => {
  let app: ReturnType<typeof buildApp>;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    app = buildApp({ db, receiptsRoot: "/tmp/qsp", ocr: "disabled", securityMapper: "disabled", perkClient: "disabled", stockClient: "disabled" });
  });

  function postJson(path: string, body: unknown) {
    return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  const profileBody = {
    name: "楽天カード", brand: "rakuten", source: "credit-card", encoding: "shift_jis",
    header_skip: 1, col_date: 0, col_payee: 1, col_amount: 4, amount_sign: "out",
    detect_keywords: ["利用店名"], account_default: "楽天カード",
  };

  it("CRUD: 作成 → 一覧 → 重複 brand は 409 → 削除", async () => {
    const c = await postJson("/v1/statement-profiles", profileBody);
    expect(c.status).toBe(201);
    const created = (await c.json()) as { profile: { id: number } };

    const list = (await (await app.request("/v1/statement-profiles")).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);

    const dup = await postJson("/v1/statement-profiles", profileBody);
    expect(dup.status).toBe(409);

    const del = await app.request(`/v1/statement-profiles/${created.profile.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("登録した profile で CSV import (brand 指定 + auto-detect)", async () => {
    await postJson("/v1/statement-profiles", profileBody);
    const content_b64 = rakutenCsv().toString("base64");

    // brand 明示
    const r1 = await postJson("/v1/imports", { brand: "rakuten", content_b64 });
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { brand: string; inserted: number };
    expect(j1.brand).toBe("rakuten");
    expect(j1.inserted).toBe(2);

    // auto-detect (再 import なので duplicates になるが brand は当たる)
    const r2 = await postJson("/v1/imports", { content_b64 });
    const j2 = (await r2.json()) as { brand: string; duplicates: number };
    expect(j2.brand).toBe("rakuten");
    expect(j2.duplicates).toBe(2);
  });

  it("行動分析が profile 取込のクレカ tx を拾う", async () => {
    await postJson("/v1/statement-profiles", profileBody);
    await postJson("/v1/imports", { brand: "rakuten", content_b64: rakutenCsv().toString("base64") });
    const beh = (await (await app.request("/v1/invest/behavior?source=credit-card")).json()) as { items: { payee_sample: string }[] };
    expect(beh.items.map((e) => e.payee_sample).sort()).toEqual(["スターバックス渋谷", "楽天市場"]);
  });
});
