---
task: ocr-ga-outcome-threshold-decision
project: Quaestor
kind: 設計相談
created: 2026-09-03
memory_links:
  - E:/Document/Ars/spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md
  - spec/feature/ocr-ga-evaluation.md
  - spec/tasks/2026-09-03-ocr-ga-b6-gpu-batch-speedup.md
  - spec/tasks/2026-09-03-ocr-ga-b1-capture-detect-backend.md
---
# OCR-GA の成果判定基準を実測値から決め直し、GA を続けるか判断する

## 目的

設計書 §3.2 の判定基準「20 世代で best が baseline +0.05 未満なら効いていない」「train − holdout > 0.10
で過学習」は **仮置き** で、neco 判断 §5-5 も「B-0 / B-2 が回ってから決め直す」となっている。
B-6 で 1 個体秒数と夜間バッチの規模が実測で出たので、決め直す材料が揃いつつある。
**閾値の決め直しは自動化しない** (設計書 §3.2)。数字を並べて neco に見せ、判断を仰ぐタスク。

判断の対象は閾値そのものだけでなく、設計書 §3.5 の「A を最小で直し 4 週間観測 → 効かなければ B に落とす」
の分岐でもある。GA を続けるか、既定遺伝子 + Claude 真値 (案 B) に落とすかをここで決める。

## 揃える材料

- **夜間バッチのラベル別 baseline 分布** (`bench-report.json`)。B-0 のラベル後付けが済んだ
  コーパスで、`global` と `tag:<形状>` それぞれの baseline / best / holdout を並べる。
- **実運用の評価レコード** (`production-eval.jsonl`、B-1 で発行されるようになった)。
  直近 20 件の平均と baseline の差。
- **B-6 の速度実測** (既出、`spec/feature/ocr-ga-evaluation.md`「実測と推奨設定」):
  1 世代 ≈ 53 分 / 1.30 s per detect / 新遺伝子ごとに約 8.6 秒。
  → 「20 世代」は **20 晩**を意味する。判定までの実時間が閾値の妥当性に直結する。
- **field hit rate の偏り。** B-6 の `--limit 50 --population 8` 1 世代目で
  date 0.977 / total 1.000 に対し **payee 0.488** と低く、伸びしろは payee に偏っている。
  fitness の重み (total 0.4 / date 0.3 / payee 0.2 / items 0.1) と釣り合っているかを見る。

## 完了条件

- [ ] 上記の材料を 1 枚にまとめて neco に提示する (`bench-report.json` のラベル別表 + 実運用の直近 20 件)。
- [ ] neco 判断を得て、決まった閾値を `spec/feature/ocr-ga-evaluation.md`「判定基準」と
      設計書 §3.2 に **確定値として** 書き直す (仮置きの但し書きを外す)。
- [ ] 「GA を続ける / 案 B に落とす」の判断を設計書 §3.5 に記録する。
- [ ] 判定を自動化しないこと。閾値は人が見るための基準として書き、コードに判定ロジックを足さない。
- [ ] payee の hit rate が低いままなら、fitness の payee 正規化・重みを見直すタスクを別に切る
      (このタスクでは実装しない)。

## スコープ (編集可ディレクトリ)

`spec/feature/ocr-ga-evaluation.md`、`spec/tasks/`、および Castra 設計書
`E:/Document/Ars/spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md` §3.2 / §3.5。
**コードは変更しない** (判定を自動化しないため)。本番 DB / 画像・GA 永続は読み取りのみ。
