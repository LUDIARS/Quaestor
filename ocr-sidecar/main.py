"""
Quaestor OCR sidecar — PaddleOCR (PP-OCRv5) microservice.

レシート画像から detection(DBNet系)+recognition で「正確な polygon + text」を返す。
Quaestor web/backend がフォールバック段の本命 (PaddleFieldLocator) として叩く。

  POST /detect   multipart `image` → { lines: [{ polygon, bbox, text, score }] }
  GET  /health   → { ok, model }

起動: uvicorn main:app --host 127.0.0.1 --port 17350
依存: requirements.txt 参照。初回起動時にモデルを自動 DL する (~数十MB)。
"""

from __future__ import annotations

import io
import os
from typing import Any

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import numpy as np

app = FastAPI(title="quaestor-ocr-sidecar")

# web (vite dev / 同梱) からの直接呼び出しを許可
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# PaddleOCR は重いので遅延初期化 (起動を速く保つ)
_ocr: Any = None
_LANG = os.environ.get("QUAESTOR_OCR_LANG", "japan")


def get_ocr() -> Any:
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR  # 遅延 import
        _ocr = PaddleOCR(use_angle_cls=True, lang=_LANG, show_log=False)
    return _ocr


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": f"PP-OCRv5/{_LANG}", "loaded": _ocr is not None}


@app.post("/detect")
async def detect(image: UploadFile = File(...)) -> dict:
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty image")
    try:
        pil = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"decode failed: {e}") from e

    arr = np.array(pil)
    result = get_ocr().ocr(arr, cls=True)

    lines = []
    # PaddleOCR は [[ [poly, (text, score)], ... ]] (画像 1 枚なら result[0])
    page = result[0] if result and result[0] else []
    for entry in page:
        poly = entry[0]                     # 4 点 [[x,y], ...]
        text, score = entry[1][0], float(entry[1][1])
        xs = [float(p[0]) for p in poly]
        ys = [float(p[1]) for p in poly]
        x0, y0 = min(xs), min(ys)
        bbox = [x0, y0, max(xs) - x0, max(ys) - y0]
        lines.append({
            "polygon": [[float(p[0]), float(p[1])] for p in poly],
            "bbox": bbox,
            "text": text,
            "score": score,
        })

    return {"lines": lines, "width": pil.width, "height": pil.height}
