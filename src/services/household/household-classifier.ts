/**
 * payee → 家計費目 の解決。 household_rules に当たらなければ「その他」。
 * 仕訳帳の事業主貸行と家計分析の支出イベントの両方がここを通る (判定を 1 箇所に保つ)。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-002 (spec/feature/household-bookkeeping.md)
 */

import type { HouseholdCategoriesRepo, HouseholdCategoryRow } from "../../db/household-categories-repo.js";
import type { HouseholdRulesRepo } from "../../db/household-rules-repo.js";

export interface HouseholdClassification {
  category_id: number;
  category_name: string;
  rule_id: number | null;
}

export class HouseholdClassifier {
  private cache: Map<number, HouseholdCategoryRow> | null = null;

  constructor(
    private readonly rules: HouseholdRulesRepo,
    private readonly categories: HouseholdCategoriesRepo,
  ) {}

  /** 費目マスタが変わったら呼ぶ (API の CRUD 後)。 */
  invalidate(): void {
    this.cache = null;
  }

  private categoryMap(): Map<number, HouseholdCategoryRow> {
    if (!this.cache) this.cache = new Map(this.categories.list().map((c) => [c.id, c]));
    return this.cache;
  }

  classify(payee: string | null | undefined): HouseholdClassification {
    const hit = this.rules.resolve(payee);
    const map = this.categoryMap();
    if (hit) {
      const cat = map.get(hit.category_id);
      if (cat) return { category_id: cat.id, category_name: cat.name, rule_id: hit.rule_id };
    }
    const fallbackId = this.categories.fallbackId();
    this.invalidate();
    const fb = this.categoryMap().get(fallbackId);
    return { category_id: fallbackId, category_name: fb?.name ?? "その他", rule_id: null };
  }

  categoryName(id: number | null): string | null {
    if (id === null) return null;
    return this.categoryMap().get(id)?.name ?? null;
  }
}
