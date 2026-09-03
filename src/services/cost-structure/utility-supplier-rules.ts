/**
 * 検針票 (doc_kind='utility') の供給者を cost_rules へ入力する。
 *
 * 水道光熱費ビュー (`utility-scan.ts`) は「支出イベントの payee を cost_rules で解決し、
 * utility が付いたものを 月 × 種別 で集計する」造りなので、 検針票を活かす道は
 * **供給者名を cost_rules の utility ルールにすること**。 検出系 (recurring-detector) が
 * 統計から推測するのに対し、 検針票は紙に書かれた確定値なので、 推測より高い優先度で入れる。
 *
 * @implements SPEC-COST-STRUCTURE-005 (spec/feature/cost-structure.md)
 * @implements SPEC-SCAN-KIND-005 (spec/feature/scan-document-kinds.md)
 */

import type { CostRulesRepo } from "../../db/cost-rules-repo.js";
import type { UtilityKind } from "../../db/cost-rules-seed.js";
import { escapeRegex } from "../apportionment-sheet/rule-synthesizer.js";
import { normalizePayee } from "../../shared/text.js";

/** 検針票由来のルールの優先度。 seed (10〜50) より後、 固定費候補の提案 (300) より前。 */
const UTILITY_SCAN_RULE_PRIORITY = 200;

const SUPPLIER_PATTERNS: { kind: UtilityKind; re: RegExp }[] = [
  { kind: "electric", re: /電力|電気|でんき|デンキ|ELECTRIC|POWER|ENERGY/i },
  { kind: "gas", re: /ガス|ｶﾞｽ|GAS|プロパン|LPG/i },
  { kind: "water", re: /水道|上下水|下水|簡易水道|WATER/i },
];

/** 単位だけの手掛かりは kWh のみ (m3 / ㎥ は ガス と 水道 の両方で使われ、 決め手にならない)。 */
const USAGE_PATTERNS: { kind: UtilityKind; re: RegExp }[] = [
  { kind: "electric", re: /kwh|キロワット/i },
];

/**
 * 供給者名 (と使用量の単位) から水道光熱費の種別を推定する。 判別できなければ null。
 * 供給者名を先に見る (「東京ガス」の使用量が m3 でも gas)。 単位だけの手掛かりは kWh のみ採る
 * (m3 は ガス / 水道 の両方で使われるため、 供給者名が無いなら決められない)。
 */
export function inferUtilityKind(supplier: string | null, usage?: string | null): UtilityKind | null {
  const name = supplier?.trim() ?? "";
  for (const p of SUPPLIER_PATTERNS) if (p.re.test(name)) return p.kind;
  const unit = usage?.trim() ?? "";
  for (const p of USAGE_PATTERNS) if (p.re.test(unit)) return p.kind;
  return null;
}

/** ルールの pattern。 供給者名と (違えば) レシートの payee の両方に当たるようにする。 */
export function utilitySupplierPattern(names: (string | null | undefined)[]): string | null {
  const normalized = [...new Set(names.map((n) => normalizePayee(n)).filter((n) => n.length > 0))];
  if (normalized.length === 0) return null;
  return `^(?:${normalized.map(escapeRegex).join("|")})$`;
}

export type UtilityRuleOutcome =
  | { applied: false; reason: "unknown_supplier" | "unknown_kind" }
  | { applied: true; rule_id: number; utility: UtilityKind; created: boolean };

export interface EnsureUtilityRuleInput {
  supplier: string | null;
  /** レシートの payee (支出イベントはこちらの文字列で解決される) */
  payee?: string | null;
  usage?: string | null;
  /** note に残す日付 (yyyy-mm-dd) */
  today: string;
}

/**
 * 供給者に対応する utility ルールを用意する。 既に utility 付きで解決できるなら何もしない
 * (seed の「東京電力」など)。 同じ pattern の無効ルールがあれば内容を更新して再有効化する。
 */
export function ensureUtilitySupplierRule(rules: CostRulesRepo, input: EnsureUtilityRuleInput): UtilityRuleOutcome {
  const pattern = utilitySupplierPattern([input.supplier, input.payee]);
  if (!pattern) return { applied: false, reason: "unknown_supplier" };

  // 既存ルールで既に utility が付くなら、 検針票からルールを増やさない
  for (const name of [input.supplier, input.payee]) {
    const resolved = rules.resolve(name);
    if (resolved.utility && resolved.rule_id !== null) {
      return { applied: true, rule_id: resolved.rule_id, utility: resolved.utility, created: false };
    }
  }

  const utility = inferUtilityKind(input.supplier, input.usage) ?? inferUtilityKind(input.payee ?? null, input.usage);
  if (!utility) return { applied: false, reason: "unknown_kind" };

  const label = input.supplier?.trim() || input.payee?.trim() || null;
  const note = `utility-scan:${input.today}`;
  const existing = rules.findByPattern(pattern);
  if (existing) {
    rules.update(existing.id, {
      cost_type: "fixed",
      utility,
      label,
      priority: UTILITY_SCAN_RULE_PRIORITY,
      enabled: true,
      note,
    });
    return { applied: true, rule_id: existing.id, utility, created: false };
  }
  const id = rules.insert({
    pattern,
    cost_type: "fixed",
    utility,
    label,
    priority: UTILITY_SCAN_RULE_PRIORITY,
    note,
  });
  return { applied: true, rule_id: id, utility, created: true };
}
