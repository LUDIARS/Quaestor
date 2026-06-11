# Quaestor OCR sidecar (PaddleOCR)

レシート画像から **正確な polygon + text** を返す PaddleOCR (PP-OCRv5) の microservice。
Quaestor web/backend がフォールバック段の本命 (`PaddleFieldLocator`) として叩く。
詳細設計は `../spec/feature/scanner-overlay.md` §4 (点3-B)。

## 役割

- detection (DBNet系) + recognition で文字/行の **本物 BB** を返す → 検知 BB の演出分離 (点1) と
  ブラックボックス学習データ収集 (点2) の供給源。
- ローカル・オフライン・無料。日本語含む 106 言語対応。

## セットアップ & 起動

```bash
cd ocr-sidecar
python -m venv .venv
. .venv/Scripts/activate    # Windows: .venv\Scripts\activate.bat
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 17350
```

初回起動時にモデルを自動 DL する (~数十MB、`~/.paddleocr` にキャッシュ)。

## API

| method | path | body | resp |
|---|---|---|---|
| POST | `/detect` | multipart `image` | `{ lines: [{ polygon, bbox, text, score }], width, height }` |
| GET | `/health` | — | `{ ok, model, loaded }` |

`bbox` = `[x, y, w, h]`、`polygon` = 4 点 `[[x,y],...]` (いずれも画像ピクセル座標)。

## web/backend からの接続

- web (vite): 環境変数 `VITE_OCR_SIDECAR_URL` (既定 `http://127.0.0.1:17350`)
- 未起動でも web は Tesseract → Fallback に自動退避する (`ChainedFieldLocator`)。

## C (将来): YOLO 学習

点2 で蓄積した `app_data/training/receipts/yolo/` (画像 + 正規化ラベル) を使い、
レシート領域/フィールド検出器を学習する。学習スクリプトは `train/` に置く想定 (未実装)。
データが十分貯まってから着手。
