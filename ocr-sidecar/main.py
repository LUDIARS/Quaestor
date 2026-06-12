"""
Quaestor OCR sidecar — PaddleOCR (PP-OCRv5) microservice.

レシート画像から detection(DBNet系)+recognition で「正確な polygon + text」を返す。
Quaestor web/backend がフォールバック段の本命 (PaddleFieldLocator) として叩く。

  POST /detect   multipart `image` (+任意 `genome` JSON) → { lines: [{ polygon, bbox, text, score }] }
  GET  /health   → { ok, model }

`genome` は OCR-GA (遺伝的最適化) の det/rec パラメータ。指定すると、そのパラメータの
PaddleOCR インスタンス (キャッシュ) で実行する。LLM 検出待ちの間 web が複数パラメータで
反復し、後で真値と照合して良い遺伝子を残す (genetic.ts / ocr-ga.ts)。

起動: uvicorn main:app --host 127.0.0.1 --port 17350
依存: requirements.txt 参照。初回起動時にモデルを自動 DL する (~数十MB)。
"""

from __future__ import annotations

import io
import os
import json
from typing import Any, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
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

_LANG = os.environ.get("QUAESTOR_OCR_LANG", "japan")

# det/rec パラメータ (遺伝子) ごとに PaddleOCR インスタンスをキャッシュ。
# モデル重みは内部で共有されるため、複数パラメータの並存は概ね許容範囲。
_OCR_CACHE: dict[tuple, Any] = {}
_OCR_CACHE_MAX = 12

# 遺伝子 → PaddleOCR init kwargs。範囲外/未指定はデフォルトに丸める。
_DEFAULT_GENOME = {
    "detThresh": 0.3, "boxThresh": 0.6, "unclipRatio": 1.6,
    "limitSideLen": 960, "useDilation": False, "dropScore": 0.5,
}


def _genome_key(g: dict) -> tuple:
    return (
        round(float(g.get("detThresh", 0.3)), 3),
        round(float(g.get("boxThresh", 0.6)), 3),
        round(float(g.get("unclipRatio", 1.6)), 3),
        int(g.get("limitSideLen", 960)),
        bool(g.get("useDilation", False)),
        round(float(g.get("dropScore", 0.5)), 3),
    )


def get_ocr(genome: Optional[dict] = None) -> Any:
    g = {**_DEFAULT_GENOME, **(genome or {})}
    key = _genome_key(g)
    inst = _OCR_CACHE.get(key)
    if inst is None:
        from paddleocr import PaddleOCR  # 遅延 import
        inst = PaddleOCR(
            use_angle_cls=True,
            lang=_LANG,
            show_log=False,
            det_db_thresh=key[0],
            det_db_box_thresh=key[1],
            det_db_unclip_ratio=key[2],
            det_limit_side_len=key[3],
            use_dilation=key[4],
            drop_score=key[5],
        )
        if len(_OCR_CACHE) >= _OCR_CACHE_MAX:
            _OCR_CACHE.pop(next(iter(_OCR_CACHE)))  # 最古を捨てる
        _OCR_CACHE[key] = inst
    return inst


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": f"PP-OCRv5/{_LANG}", "cached_genomes": len(_OCR_CACHE)}


@app.post("/detect")
async def detect(image: UploadFile = File(...), genome: Optional[str] = Form(default=None)) -> dict:
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty image")
    try:
        pil = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"decode failed: {e}") from e

    g: Optional[dict] = None
    if genome:
        try:
            g = json.loads(genome)
        except Exception:  # noqa: BLE001
            g = None

    arr = np.array(pil)
    result = get_ocr(g).ocr(arr, cls=True)

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

    return {"lines": lines, "width": pil.width, "height": pil.height, "genome": g}
