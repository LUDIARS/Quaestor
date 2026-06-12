"""
Quaestor OCR sidecar — PaddleOCR microservice.

レシート画像から detection(DBNet系)+recognition で「正確な polygon + text」を返す。
Quaestor web/backend がフォールバック段の本命 (PaddleFieldLocator) として叩く。

  POST /detect   multipart `image` (+任意 `genome` JSON) → { lines: [{ polygon, bbox, text, score }] }
  GET  /health   → { ok, model }

`genome` は OCR-GA (遺伝的最適化) の det/rec パラメータ。指定すると、そのパラメータの
PaddleOCR インスタンス (キャッシュ) で実行する。LLM 検出待ちの間 web が複数パラメータで
反復し、後で真値と照合して良い遺伝子を残す (genetic.ts / ocr-ga.ts)。

PaddleOCR は 2.x (PP-OCRv4, det_db_* / .ocr) と 3.x (PP-OCRv5, text_det_* / .predict)
の両 API に対応する (インストールされた版を自動判別)。

起動: uvicorn main:app --host 127.0.0.1 --port 17350
依存: requirements.txt 参照。初回起動時にモデルを自動 DL する (~数十MB)。
言語は QUAESTOR_OCR_LANG (supervisor が quaestor.config.json から起動時注入。既定 japan)。
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


def _paddleocr_major() -> int:
    import paddleocr
    try:
        return int(str(getattr(paddleocr, "__version__", "2")).split(".")[0])
    except Exception:  # noqa: BLE001
        return 2


def _genome_key(g: dict) -> tuple:
    return (
        round(float(g.get("detThresh", 0.3)), 3),
        round(float(g.get("boxThresh", 0.6)), 3),
        round(float(g.get("unclipRatio", 1.6)), 3),
        int(g.get("limitSideLen", 960)),
        bool(g.get("useDilation", False)),
        round(float(g.get("dropScore", 0.5)), 3),
    )


def _make_ocr(key: tuple) -> Any:
    from paddleocr import PaddleOCR  # 遅延 import (起動を軽くする)
    if _paddleocr_major() >= 3:
        # 3.x (PP-OCRv5): パラメータ名が text_det_* / text_rec_* に変更。
        # useDilation 相当は廃止されたため無視する (遺伝子としては no-op)。
        # enable_mkldnn=False: Windows CPU の oneDNN+PIR で
        # "ConvertPirAttribute2RuntimeAttribute not support" クラッシュを回避。
        return PaddleOCR(
            lang=_LANG,
            device="cpu",
            enable_mkldnn=False,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=True,
            text_det_thresh=key[0],
            text_det_box_thresh=key[1],
            text_det_unclip_ratio=key[2],
            text_det_limit_side_len=key[3],
            text_det_limit_type="max",
            text_rec_score_thresh=key[5],
        )
    # 2.x (PP-OCRv4 以前)
    return PaddleOCR(
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


def get_ocr(genome: Optional[dict] = None) -> Any:
    g = {**_DEFAULT_GENOME, **(genome or {})}
    key = _genome_key(g)
    inst = _OCR_CACHE.get(key)
    if inst is None:
        inst = _make_ocr(key)
        if len(_OCR_CACHE) >= _OCR_CACHE_MAX:
            _OCR_CACHE.pop(next(iter(_OCR_CACHE)))  # 最古を捨てる
        _OCR_CACHE[key] = inst
    return inst


def _lines_v3(result: Any) -> list[dict]:
    """PaddleOCR 3.x の .predict() 結果 → lines。"""
    lines: list[dict] = []
    res = result[0] if result else None
    if res is None:
        return lines
    # OCRResult は dict 派生。dict でなければ .json から取り出す。
    data: Any = res
    if not isinstance(data, dict):
        j = getattr(res, "json", None)
        data = j.get("res", j) if isinstance(j, dict) else None
    if not isinstance(data, dict):
        return lines
    texts = data.get("rec_texts") or []
    scores = data.get("rec_scores") or []
    polys = data.get("rec_polys")
    if polys is None or len(polys) == 0:
        polys = data.get("dt_polys") or []
    for i, text in enumerate(texts):
        poly = polys[i] if i < len(polys) else None
        if poly is None:
            continue
        pts = [[float(p[0]), float(p[1])] for p in np.asarray(poly).reshape(-1, 2)]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x0, y0 = min(xs), min(ys)
        score = float(scores[i]) if i < len(scores) else 0.0
        lines.append({
            "polygon": pts,
            "bbox": [x0, y0, max(xs) - x0, max(ys) - y0],
            "text": str(text),
            "score": score,
        })
    return lines


def _lines_v2(result: Any) -> list[dict]:
    """PaddleOCR 2.x の .ocr() 結果 ([[ [poly, (text, score)], ... ]]) → lines。"""
    lines: list[dict] = []
    page = result[0] if result and result[0] else []
    for entry in page:
        poly = entry[0]
        text, score = entry[1][0], float(entry[1][1])
        xs = [float(p[0]) for p in poly]
        ys = [float(p[1]) for p in poly]
        x0, y0 = min(xs), min(ys)
        lines.append({
            "polygon": [[float(p[0]), float(p[1])] for p in poly],
            "bbox": [x0, y0, max(xs) - x0, max(ys) - y0],
            "text": text,
            "score": score,
        })
    return lines


@app.get("/health")
def health() -> dict:
    major = _paddleocr_major()
    model = f"PP-OCRv5/{_LANG}" if major >= 3 else f"PP-OCRv4/{_LANG}"
    return {"ok": True, "model": model, "paddleocr_major": major, "cached_genomes": len(_OCR_CACHE)}


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
    inst = get_ocr(g)
    if _paddleocr_major() >= 3:
        lines = _lines_v3(inst.predict(arr))
    else:
        lines = _lines_v2(inst.ocr(arr, cls=True))

    return {"lines": lines, "width": pil.width, "height": pil.height, "genome": g}
