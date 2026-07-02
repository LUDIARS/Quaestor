import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { AccountCodesRepo } from "../src/db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";
import {
  ApportionmentAdvisor, apportionmentFeatures, amountBand, payeePattern,
  type ApportionmentInput, type ApportionmentLlm, type ApportionmentOutput,
} from "../src/services/apportionment-advisor.js";
import type { FeatureMap, LlmContext, LlmJudgement } from "@ludiars/blackbox";

/** 常に rate=1/code=26 + payee 完全一致ルールを提案する fake LLM。 */
class FakeLlm implements ApportionmentLlm {
  calls = 0;
  lastContext: LlmContext | null = null;
  constructor(private readonly out: ApportionmentOutput = { rate: 1, code: 26 }) {}
  async judge(
    _input: ApportionmentInput, features: FeatureMap, context: LlmContext,
  ): Promise<LlmJudgement<ApportionmentOutput>> {
    this.calls += 1;
    this.lastContext = context;
    return {
      output: this.out,
      confidence: 0.9,
      rationale: "fake",
      proposedRule: {
        description: `${features.payee} は経費`,
        when: { op: "cmp", feature: "payee", cmp: "==", value: features.payee },
        output: this.out,
        confidence: 0.8,
      },
    };
  }
}

function insertTx(db: Database.Database, payee: string, amountOut: number, n = 1): void {
  const stmt = db.prepare(
    `INSERT INTO transactions (id, date, amount_out, description, payee, source, created_at, updated_at)
     VALUES (?, '2026-06-01', ?, ?, ?, 'credit-card', 0, 0)`,
  );
  for (let i = 0; i < n; i++) stmt.run(`tx-${payee}-${i}`, amountOut, payee, payee);
}

describe("ApportionmentAdvisor (成長型ブラックボックス)", () => {
  let db: Database.Database;
  let rules: ApportionmentRulesRepo;
  let accounts: AccountCodesRepo;
  let llm: FakeLlm;
  let advisor: ApportionmentAdvisor;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    accounts = new AccountCodesRepo(db);
    rules = new ApportionmentRulesRepo(db);
    accounts.seedIfEmpty();
    rules.seedIfEmpty();
    llm = new FakeLlm();
    advisor = new ApportionmentAdvisor({ db, rules, accounts, llm });
  });

  it("listUnknownPayees は seed ルール未マッチの payee だけを返す", () => {
    insertTx(db, "NOTION", 2000);              // seed ルールにマッチ (code 26)
    insertTx(db, "謎の店テスト", 3000, 2);      // 未知
    const unknown = advisor.listUnknownPayees();
    expect(unknown.map((u) => u.payee)).toEqual(["謎の店テスト"]);
    expect(unknown[0].txCount).toBe(2);
  });

  it("advise → LLM 判定 + candidate 蓄積、繰り返しで trial 発火 (LLM 卒業へ前進)", async () => {
    insertTx(db, "謎の店テスト", 3000);
    // 1回目: 提案 / 2〜4回目: 影一致 → trial 昇格
    for (let i = 0; i < 4; i++) await advisor.adviseUnknown();
    expect(llm.calls).toBe(4);
    const bbRules = advisor.listRules();
    expect(bbRules).toHaveLength(1);
    expect(bbRules[0].state).toBe("trial");
    // 5回目: trial ルールが発火し LLM は呼ばれない
    const [r] = await advisor.adviseUnknown();
    expect(llm.calls).toBe(4);
    expect(r.source).toBe("rule");
    expect(r.status).toBe("pending_review");
    expect(r.code).toBe(26);
  });

  it("OK×3 で auto に卒業し apportionment_rules へ実体化 → resolve が引き受ける", async () => {
    insertTx(db, "謎の店テスト", 3000);
    for (let i = 0; i < 4; i++) await advisor.adviseUnknown(); // trial まで
    let materialized: number | null = null;
    for (let i = 0; i < 3; i++) {
      const [r] = await advisor.adviseUnknown();
      const res = advisor.review(r.decisionId, "ok");
      materialized = res.materializedRuleId ?? materialized;
    }
    expect(materialized).not.toBeNull();
    const resolved = rules.resolve("謎の店テスト");
    expect(resolved.rule_id).toBe(materialized);
    expect(resolved.rate).toBe(1);
    expect(resolved.code).toBe(26);
    // 実体化されたので listUnknownPayees からも消える
    expect(advisor.listUnknownPayees()).toHaveLength(0);
    // 二重実体化しない
    expect(advisor.materialize(advisor.listRules()[0])).toBeNull();
  });

  it("NG×3 で撤回され、撤回ルールが LLM context に載る", async () => {
    insertTx(db, "謎の店テスト", 3000);
    for (let i = 0; i < 4; i++) await advisor.adviseUnknown(); // trial まで
    for (let i = 0; i < 3; i++) {
      const [r] = await advisor.adviseUnknown();
      advisor.review(r.decisionId, "ng");
    }
    expect(advisor.listRules()[0].state).toBe("retired");
    await advisor.adviseUnknown(); // LLM に戻る
    expect(llm.lastContext?.retiredRules).toHaveLength(1);
  });

  it("LLM 無しの advise は投げる (API は 503)", async () => {
    const noLlm = new ApportionmentAdvisor({ db, rules, accounts });
    expect(noLlm.llmAvailable).toBe(false);
    await expect(noLlm.adviseUnknown()).rejects.toThrow();
  });
});

describe("pure helpers", () => {
  it("amountBand の境界", () => {
    expect(amountBand(999)).toBe("<1k");
    expect(amountBand(1000)).toBe("1k-10k");
    expect(amountBand(10_000)).toBe("10k-100k");
    expect(amountBand(100_000)).toBe("100k+");
  });

  it("apportionmentFeatures は payee を正規化する", () => {
    const f = apportionmentFeatures({ payee: "ＡＢＣ  Ｄ", source: "credit-card", avgAmountOut: 500, txCount: 1 });
    expect(typeof f.payee).toBe("string");
    expect(f.amountBand).toBe("<1k");
  });

  it("payeePattern は == / in を regex 化し、他条件は null", () => {
    expect(payeePattern({ op: "cmp", feature: "payee", cmp: "==", value: "A.B(C)" })).toBe("A\\.B\\(C\\)");
    expect(payeePattern({ op: "in", feature: "payee", values: ["X", "Y"] })).toBe("X|Y");
    expect(payeePattern({ op: "cmp", feature: "amountBand", cmp: "==", value: "<1k" })).toBeNull();
  });
});
