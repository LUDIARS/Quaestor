#!/usr/bin/env bash
# OCR sidecar setup (Linux / macOS)
# Creates a local virtualenv and installs PaddleOCR deps.
# After this, Quaestor auto-starts the sidecar from .venv on launch.
#
# venv を作る python は quaestor.config.json の ocrSidecar.venvPython が正本
# (null なら python3.12 → python3.9 を自動探索)。
# paddlepaddle は Python 3.9〜3.12 のみ wheel 提供のため必ずガードする。
set -euo pipefail
cd "$(dirname "$0")"

version_ok() {
  "$1" -c 'import sys; sys.exit(0 if (sys.version_info[0] == 3 and 9 <= sys.version_info[1] <= 12) else 1)' 2>/dev/null
}

resolve_python() {
  # 1) quaestor.config.json の ocrSidecar.venvPython
  local cfg="../quaestor.config.json"
  if [ -f "$cfg" ]; then
    local explicit
    explicit=$(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get("ocrSidecar",{}).get("venvPython"); print(v or "")' "$cfg" 2>/dev/null || true)
    if [ -n "$explicit" ]; then
      if ! version_ok "$explicit"; then
        echo "ERROR: quaestor.config.json の ocrSidecar.venvPython ($explicit) は Python 3.9-3.12 ではない (paddlepaddle の wheel が無い)" >&2
        exit 1
      fi
      echo "$explicit"; return
    fi
  fi
  # 2) 3.12 → 3.9 を自動探索
  for v in 3.12 3.11 3.10 3.9; do
    if command -v "python$v" >/dev/null 2>&1; then echo "python$v"; return; fi
  done
  # 3) python3 (バージョンガード付き)
  if version_ok python3; then echo "python3"; return; fi
  echo "ERROR: Python 3.9-3.12 が見つからない。quaestor.config.json の ocrSidecar.venvPython にパスを指定してください (3.13+ は paddlepaddle 非対応)" >&2
  exit 1
}

if [ ! -d .venv ]; then
  base=$(resolve_python)
  echo "Creating virtualenv (.venv) with $base ..."
  "$base" -m venv .venv
elif ! version_ok .venv/bin/python; then
  echo "ERROR: 既存の .venv が Python 3.9-3.12 ではない。.venv を削除して再実行してください" >&2
  exit 1
fi

.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt

echo ""
echo "OCR sidecar ready. Quaestor will auto-start it (port 17350) on launch."
echo "Manual run: .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 17350"
