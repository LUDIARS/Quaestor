# Quaestor — Design

## 全体図

```
┌─────────────────────────────────┐    ┌──────────────────┐
│ React UI (Vite + Foundation UI) │◄──►│ Backend (Hono)   │
│  - Scan page (手動/AR 撮影)     │    │  - REST + WS     │
│  - Ledger / Reconcile pages     │    │  - SQLite (better│
│  - Importer wizards             │    │    -sqlite3)     │
└────────────┬────────────────────┘    └────────┬─────────┘
             │                                  │
        getUserMedia                       Anthropic SDK
        Canvas binary                      (vision OCR)
             │                                  │
             ▼                                  ▼
        Receipt frame ──────── HTTP POST ────► OCR worker
```

Tauri 2 wrapper は backend を internal subprocess として起動し、 webview から `localhost:NNNN` を読む形 (Memoria / Hora と同パターン)。 純 web 起動も同 backend を spawn せず外部サーバ向きに切替できる。

## モジュール構成 (案)

```
src/
├── ar-scanner/         # 1. AR receipt scanner
│   ├── camera.ts        # getUserMedia + frame loop
│   ├── detector.ts      # 128x256 binarize + rect candidate
│   ├── capture.ts       # 高解像度フレーム抜き
│   └── ocr-client.ts    # backend に送って OCR 結果受領
├── ledger/             # 2. 共通 record / DB
│   ├── schema.ts        # 正規化レコード定義 (extensible)
│   ├── repo.ts          # SQLite CRUD
│   └── migrations/
├── importers/          # CSV / PDF / Amazon
│   ├── credit-card-csv.ts
│   ├── bank-pdf.ts
│   ├── amazon-history.ts
│   └── receipt.ts        # OCR 結果 → record
├── reconcile/          # 照合エンジン
│   ├── match.ts          # date ± N + amount + 店名類似度
│   └── relation.ts       # receipt ⇄ tx の双方向リンク
└── ui/                 # React components / pages
```

backend は別 package (`backend/` or workspace) に切るかも。 v0.0 では同 repo monorepo (npm workspaces) で進める。

## 正規化レコード (Ledger)

全 source を 1 つの `transactions` テーブルに合流。 source 固有データは `metadata` JSON で保持して拡張性を確保。

```ts
type Transaction = {
  id: string;                  // ULID
  date: string;                // ISO 8601 (yyyy-mm-dd)
  amount_in: number | null;    // 入金 (円, integer 最小単位)
  amount_out: number | null;   // 出金
  currency: "JPY" | string;    // 元通貨
  fx_amount?: number;          // 外貨決済の元金額
  fx_currency?: string;
  description: string;         // 摘要 (生)
  payee: string | null;        // 支払先 (店名 / 振込先)
  source: "credit-card" | "bank" | "amazon" | "receipt" | "manual";
  source_id: string;           // 元 CSV/PDF/order の id (importer 由来)
  account: string;             // 楽天カード / 三菱 UFJ 普通 etc
  metadata: Record<string, unknown>; // source 固有の生データ全部入れて良い
  created_at: number;
  updated_at: number;
};

type Receipt = {
  id: string;                  // ULID
  captured_at: number;         // unix (ts of frame capture)
  date: string | null;         // OCR 抽出
  payee: string | null;
  total: number | null;
  items: { name: string; price: number; qty?: number }[];
  geo?: { lat: number; lon: number; accuracy?: number };
  image_path: string;          // local file (originals/yyyy/mm/<id>.jpg)
  ocr_raw: string;             // Claude vision の raw response 保持
  committed_at: number | null; // 「投入」 済 unix ts。 null = 未投入 (撮影/OCR 待ち or 要編集)
  metadata: Record<string, unknown>;
};

type Reconciliation = {
  id: string;
  receipt_id: string;
  transaction_id: string;
  matched_by: "auto" | "manual";
  confidence: number;          // 0..1
  notes?: string;
  created_at: number;
};
```

`metadata` を持たせることで extension が DB schema 変更なしに追加できる。

## レシート撮影 — 2 モード

撮影は **手動シャッター (既定)** と **AR 自動検出 (opt-in)** の 2 モード。 Scan ページ上部で
切替し、選択は localStorage に保持する。 どちらも backend の `POST /v1/receipts` に画像を投げる点は共通で、
違いは「いつシャッターを切るか」 だけ。 OCR / 保存 / キュー / 照合は検知方式に依存しない。

### 手動シャッター (manual) — 既定

端で受領書を自動検出する必要は実運用上なかったため、 普通にパシャパシャ撮る方式を既定とする。

1. `<video>` に getUserMedia stream を流す (環境カメラ優先)。 検知ループは回さない
2. ユーザがシャッターボタンを押すたびに現フレームを jpeg 化 (最大辺 1080px) → `POST /v1/receipts`
   (`metadata.kind = "manual"`)。 何枚でも連写できる
3. backend は画像を保存 + **image-hash で直近 30 秒の同一フレーム連投を dedup** (二度押し対策) し、
   pending receipt を作る。 `kind=manual` は自動で OCR を起動する (Anthropic SDK or Claude Code CLI)
4. フロントは「このセッションの撮影」 リストで各 receipt の OCR 進捗を poll 表示
5. **投入ゲート**: 日付・場所 (payee)・金額 (total) が揃ったら「投入」 ボタンが活性化。 欠けていれば
   `ReceiptEditor` で補完してから投入
6. 投入 = `POST /v1/receipts/:id/commit`。 server が完備チェック + 重複判定の上で `committed_at` をセット

### AR 自動検出 (ar) — opt-in (旧来方式)

1. 30 fps で各フレームを `<canvas>` に縮小描画 (最大辺 256) → グレースケール + 適応的二値化
2. 連結成分から大きな白矩形を抽出、 アスペクト比 + 占有率 + Tesseract キーワード (合計 等) で score
3. score が閾値超えで N フレーム連続安定したら高解像度フレームを grab (`kind=stable`) → `POST /v1/receipts`
4. 以降は manual と同じ (OCR → 投入)

性能目標: AR 検出ループは 30 fps を保ち、 OCR レイテンシは 2-5 秒許容。

## ユニーク判定 (投入時の dedup)

撮影直後の image-hash dedup は「同じ 1 フレームの連投」 を弾くだけ。 **会計上の重複判定は
(日付 - 場所 - 金額) の組** で行う (`POST /v1/receipts/:id/commit`)。

- 完備チェック: `date` / `payee` / `total` のいずれか欠落 → 422 `incomplete` (投入不可)
- 重複判定: 既に投入済 (`committed_at IS NOT NULL`) の中に同じ (date, payee, total) があれば 409 `duplicate`。
  payee は `normalizePayee` (全角→半角・空白圧縮・大小無視) で正規化突合
- 投入は冪等 (再投入は `already:true` を返すだけ)

## 取引取り込み (Importers)

### Credit card CSV

各社カードでフォーマットがブレるので、 importer は **header sniff + field mapping config** で解決。 `importers/credit-card-csv/<brand>.json` に header → field の写像を持つ。 未対応 brand はユーザが GUI で mapping 作成 → 保存して再利用可能。

### Bank PDF

`pdfjs-dist` でテキスト抽出 + 表構造復元。 銀行ごとに layout が異なるので、 brand-specific parser をプラグイン式に。 v0.0 は MUFG / SMBC / 楽天 あたりから。

### Amazon order history

Amazon は CSV export を提供しないので、 注文履歴ページの HTML を保存 → 解析 or "Order History Reports" (legacy) があれば CSV。 export 仕様の変動があるので **ユーザが手動 download した HTML/CSV** を読む方式に倒す。

### Receipt

AR scanner 経由で生成された `Receipt` を `transactions` には複製しない (別テーブル)。 reconcile で双方リンクする。

## 照合 (Reconcile)

1. 候補絞り込み: 同 date ± 3 日、 amount 一致 (税込/税抜揺れ対応で ±5%)
2. 店名類似度: payee + receipt.payee を `levenshtein` + 半角全角正規化
3. confidence = w1*date_score + w2*amount_score + w3*payee_score
4. 0.85 以上なら auto-match、 0.5–0.85 はユーザ承認待ち、 それ未満は捨てる
5. ユーザが手動で結合・分離可

## 個人データ・セキュリティ

- DB ファイルは `app_data/quaestor.db`。 デフォルトローカルのみ
- レシート画像は `app_data/receipts/yyyy/mm/<id>.jpg`
- OCR は Anthropic API に送信 (注: 画像が外部に出る)。 API key は OS keychain に置き、 ユーザが明示的に enable
- Cloud sync (オプション、 v0.2+): 想定先は Memoria の Imperativus 経由 or 専用 endpoint。 一旦は範囲外
- LUDIARS 個人データルール (AIFormat §5 = Cernere 単一情報源) との整合: Quaestor の取引データは「会計データ」 (個人プロフィール / 連絡先ではない) なので、 Cernere 経由ではなくローカル完結を妥当とする。 別 issue で AIFormat 側に Quaestor の例外を追記する予定

## 過去資産 (calc) からの継承

`E:\calc` で確定申告 2025 用に作った personal toolset から学びを抽出済。 詳細は [`spec/calc-lessons.md`](./spec/calc-lessons.md)、 標準科目体系と按分率初期 seed は [`spec/account-codes.md`](./spec/account-codes.md) 参照。

主な継承ポイント:
- SJIS CSV (iconv-lite)、 日付 4 形式、 金額正規化
- ブランド別 importer (UFJ / SMBC 系 / 楽天 …) — header sniff + plugin 構造
- 按分率 + 科目コードを ルール DB 化 (calc では js ハードコードだったものを 1st-class data に昇格)
- Amazon shipment grouping (`orderId + shipDate`)
- SMBC 銀行 PDF parser
- 仕訳帳 Excel export (calc 互換シート構造) は v1.0 機能

calc に無くて Quaestor が新規に持つもの: **AR レシートスキャナ + receipt × transaction reconcile**。

## ロードマップ (草案)

- v0.0: scaffold, README/DESIGN/data-model/calc-lessons
- v0.1: backend + DB + ledger schema + UFJ CSV import (calc 移植)
- v0.2: 按分率ルール CRUD + UI で初期 seed 確認
- v0.3: AR scanner detector (camera + 二値解析、 OCR は stub)
- v0.4: OCR 接続 (Anthropic vision) + receipt insert
- v0.5: receipt × transaction reconcile auto-match + UI 承認
- v0.6: Amazon Order History import (shipment grouping)
- v0.7: SMBC 系クレカ + SMBC 銀行 PDF
- v0.8: Tauri 2 wrap
- v1.0: 仕訳帳 Excel export (calc 互換) + 確定申告下準備

## 未決事項

- 単独 PWA で行ける範囲 vs Tauri 必須機能の線引き
- 受領書 (領収書、 経費精算用 = 確定申告に効く) の receipt とのスキーマ統合 / 分離
- 多 user / multi-account 対応 (家族間共有) はやるか
- 銀行 PDF のレイアウト変更追従コスト — 過剰なら CSV のみに割り切る判断もあり
