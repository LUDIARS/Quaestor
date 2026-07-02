# 科目学習アドバイザ (apportionment-advisor) — 成長型ブラックボックス採用

未知 payee (apportionment_rules 未マッチ → fallback rate=0/code=124) の
経費按分率・科目コード判定を、共通ライブラリ **@ludiars/blackbox**
(LUDIARS/Lapilli、設計正本 `packages/blackbox/DESIGN.md`) で学習する。

## 流れ

1. `POST /v1/apportionment-advisor/advise {limit}` — 未マッチ payee を支出額順に
   blackbox 判定。学習済み (trial/auto) ルールは LLM 無しで即決、未知は
   claude CLI (`ClaudeCliApportionmentLlm`、サブスク auth) が {rate, code} を判定し
   payee 完全一致の Condition ルール候補を提案する。
2. 提案は candidate として蓄積され、advise を繰り返すたびに**影評価**
   (LLM 出力との突合) で信頼を積む。一致 3 回で trial (発火 + 人間レビュー) に昇格。
3. `GET /v1/apportionment-advisor/review` のキューに trial 発火 + LLM 判断が載り、
   `POST /review/:id {verdict: ok|ng}` で OK/NG。OK×3 で auto (卒業)。
4. **卒業時に apportionment_rules へ regex ルールとして実体化** (priority 500、
   note に `blackbox:<指紋>` を刻み二重化防止)。以後その payee は journal 等の
   決定的 resolve が引き受け、LLM は完全に不要になる。NG×3 は撤回 + 再提案ブロック。

## 境界

- テーブル (blackbox_rules / blackbox_decisions) は `ensureBlackboxSchema()` が作成。
  schema.ts の user_version 管理外 (他機能の migration と衝突しない)。
- payee 以外の条件 (amountBand 等) のルールは実体化できず blackbox 内に留まる
  (プロンプトで payee 完全一致を推奨済み)。
- LLM 無し環境では advise が 503、レビュー/ルール参照は動く。
- domain: `accounting.apportionment`。卒業メトリクスは `GET /rules` の stats
  (ruleCoverage = ルール由来判断の割合)。

## 関連

- `src/services/apportionment-advisor.ts` / `src/api/apportionment-advisor.ts`
- `tests/apportionment-advisor.test.ts`
- レシート検知の GA (`src/services/genetic.ts`) は数値最適化で別物 (併存)
