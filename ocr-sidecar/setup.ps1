# OCR sidecar setup (Windows / PowerShell)
# Creates a local virtualenv and installs PaddleOCR deps.
# After this, Quaestor auto-starts the sidecar from .venv on launch.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $dir

if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtualenv (.venv) ..."
    python -m venv .venv
}

$py = ".venv\Scripts\python.exe"
& $py -m pip install --upgrade pip
& $py -m pip install -r requirements.txt

Write-Host ""
Write-Host "OCR sidecar ready. Quaestor will auto-start it (port 17350) on launch."
Write-Host "Manual run: $py -m uvicorn main:app --host 127.0.0.1 --port 17350"
