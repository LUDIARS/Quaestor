#!/usr/bin/env bash
# OCR sidecar setup (Linux / macOS)
# Creates a local virtualenv and installs PaddleOCR deps.
# After this, Quaestor auto-starts the sidecar from .venv on launch.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtualenv (.venv) ..."
  python3 -m venv .venv
fi

.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt

echo ""
echo "OCR sidecar ready. Quaestor will auto-start it (port 17350) on launch."
echo "Manual run: .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 17350"
