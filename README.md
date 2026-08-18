# Quaestor

ラテン: Quaestor = 古代ローマの財務官。 個人会計を自動化する LUDIARS 兄弟の 1 サービス。

## 目的

家計簿管理 + 確定申告下準備の自動化。 入力源 (レシート / クレカ CSV / 銀行 PDF / Amazon 履歴) を 1 つの正規化レコードに統合し、 横断照合できるようにする。

## 2 つの柱

### 1. AR レシートスキャナ (WebUI)

- Web カメラを `getUserMedia` で起動、 リアルタイムプレビュー
- 各フレームを 128×256 程度に縮小し二値化、 「白っぽい矩形」 を高速検出
- レシート候補を見つけたフレームで高解像度キャプチャ → OCR (Claude vision) に投げる
- 抽出: 日付 / 店名 / 位置情報 / 商品ごとの品目+金額 / 合計

### 2. 取引照合エンジン

- クレカ / 銀行の CSV / PDF / Amazon 注文履歴を取り込み、 共通スキーマに正規化
- フィールド: `date / 入金 / 出金 / 摘要 / 支払先 / 外貨額 (FX 決済時)`
- 拡張可能な record schema (各 source 固有のフィールドは `metadata` で保持)
- レシート (現物) ⇄ クレカ取引 のマッチング: 日付 ± N 日 + 金額 + 店名類似度で候補提示
- 過去の `calc` (確定申告自動化) を参考にしつつ、 通年の家計把握にも使える設計

### 3. 投資 / 優待アドバイザ

- レシート + 取引から **よく使う店・商品** を集計 (行動解析)
- その運営企業 → 証券コードを Claude で同定し、 **株価動向** (stooq) と **株主優待** を提示
- 「どうせ使う店なら株主になって優待で得をしろ」を消費行動から逆算で提案
- 優待利回り / 必要投資額 (株価 × 必要株数) も算出
- 行動分析はクレカ明細を主入力に、 月次取込 (先月分を当月) の1ヶ月遅れを考慮した完了月窓で集計
- 詳細: `spec/feature/invest-advisor.md`

### 4. 積立ポートフォリオ / 配当アドバイザ

- 今契約中の **積立投資 (つみたてNISA/投信・個別株/ETF・変額/外貨建保険)** を一元管理
- **利回り** (取得原価/含み損益/年率 XIRR) と **計画 vs 実績** (plan-variance) を算出
- **将来見通し** を保守/中立/楽観の 3 シナリオで投影 (継続積立 × 想定年率)
- **配当株サジェスト** を 公開情報のみ (配当利回り/配当性向/連続増配年数) で提示
  - ★ 未公表の重要事実 (インサイダー情報) は扱わない。 情報提示であり投資助言ではない
- 個別株/ETF の時価は stooq 自動、 投信/保険は手動評価額入力
- 詳細: `spec/feature/portfolio-advisor.md`

### 明細プロファイル (クレカ外部登録)

- UFJ / SMBC は組込。 他社カードは CSV の **列マッピングを登録するだけ** で取込可能
- 列番号 / 文字コード / ヘッダ行数 / 行フィルタ / 自動判定キーワードを GUI 登録
- 詳細: `spec/feature/statement-profiles.md`

## スタック (予定)

- Backend: Node + Hono + better-sqlite3 (Concordia と同路線)
- Frontend: React + Vite + Foundation UI
- Desktop: Tauri 2 (CSV/PDF ファイル選択や永続データのため、 単独 PWA としても起動可)
- OCR: Anthropic Claude vision (高解像度フレーム送信)
- カメラ AR: 純 web (`getUserMedia` + Canvas + ImageData 二値解析)。 WebGL 化は性能が出なければ検討

## 個人データの扱い

- 会計データはすべて **ローカル SQLite** に保管
- LUDIARS 全体ルール (個人データは Cernere 単一情報源、 自前 DB に持たない) との関係: Quaestor の取引データはそもそも外部 share 前提でない金銭情報なので、 Cernere 経由でなくローカル完結とする (AIFormat §5 の例外運用、 DESIGN.md「正規化レコード (Ledger)」節参照)
- Cloud sync は v0.x 以降に検討、 デフォルト OFF

## 開発状況

v1.0 一気通貫実装済 (2026-05-02)。 詳細は `DESIGN.md`。

機能完成度:
- ✅ AR レシートスキャナ (camera + 二値検出 + 安定検知 + HD キャプチャ)
- ✅ Anthropic vision OCR (構造化抽出 + low confidence は manual review)
- ✅ クレカ CSV importer (UFJ / SMBC、 SJIS auto-detect)
- ✅ 銀行 PDF importer (SMBC、 pdf-parse)
- ✅ Amazon Order History importer (shipment grouping)
- ✅ 按分率 + 科目コード CRUD (calc 互換 seed) + payee resolver
- ✅ receipt × transaction 照合 (auto + manual + suggestion bands)
- ✅ 仕訳帳 Excel export (calc 互換、 SerialDate / 借方貸方 / 按分行展開)
- ✅ Tauri 2 wrap scaffold (dev mode、 backend は別 process)

## 起動方法

### 開発 (web ブラウザ)

1 コマンドで backend + web を同時起動:

```powershell
cd E:\Document\Ars\Quaestor
npm install
cd web; npm install; cd ..
npm run dev:all     # backend (17400) + web vite (5117) を concurrently で同時起動
# → http://127.0.0.1:5117
```

OCR を有効化する場合は backend 起動 shell で `ANTHROPIC_API_KEY` を export。

### 開発 (Tauri デスクトップ)

```powershell
npm run tauri:dev   # beforeDevCommand が dev:all を自動起動
```

### 本番ビルド

```powershell
npm run build:all   # tsc + vite build
npm run tauri:build # exe を ./src-tauri/target/release/ に出力
```

production の Quaestor.exe は起動時に `node dist/server.js` を spawn するため、
**Node 22+ が PATH に必要**。 Node を Tauri 同梱化するのは v1.0+ の課題
(pkg / nexe / native rewrite のいずれか)。

## 個人データ取り扱い

- DB ファイル `app_data/quaestor.db` および `app_data/receipts/` 配下は `.gitignore` で除外
- リポジトリの test fixture は合成データのみ。 実 CSV / レシート画像は git に乗らない
- OCR は API key 設定時のみ Anthropic に画像を送信、 既定は OFF
