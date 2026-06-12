# OCR sidecar setup (Windows / PowerShell)
# Creates a local virtualenv and installs PaddleOCR deps.
# After this, Quaestor auto-starts the sidecar from .venv on launch.
#
# venv を作る python は quaestor.config.json の ocrSidecar.venvPython が正本
# (null なら 3.12→3.9 を py launcher で自動探索)。
# paddlepaddle は Python 3.9〜3.12 のみ wheel 提供 — 3.13+ で作ると
# "No matching distribution found for paddlepaddle" になるため必ずガードする。
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $dir

function Test-PythonVersion([string]$exe) {
    # 3.9 <= version <= 3.12 なら $true
    try {
        $v = & $exe -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')" 2>$null
        if (-not $v) { return $false }
        $parts = $v.Trim().Split(".")
        $major = [int]$parts[0]; $minor = [int]$parts[1]
        return ($major -eq 3 -and $minor -ge 9 -and $minor -le 12)
    } catch { return $false }
}

function Resolve-VenvPython {
    # 1) quaestor.config.json (リポ直下) の ocrSidecar.venvPython
    $cfgPath = Join-Path (Split-Path -Parent $dir) "quaestor.config.json"
    if (Test-Path $cfgPath) {
        try {
            $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
            $explicit = $cfg.ocrSidecar.venvPython
            if ($explicit) {
                if (-not (Test-PythonVersion $explicit)) {
                    throw "quaestor.config.json の ocrSidecar.venvPython ($explicit) は Python 3.9-3.12 ではありません (paddlepaddle の wheel が無い)"
                }
                return $explicit
            }
        } catch {
            if ($_.FullyQualifiedErrorId -notmatch "ConvertFrom-Json") { throw }
        }
    }
    # 2) py launcher で 3.12 → 3.9 を自動探索
    foreach ($ver in @("3.12", "3.11", "3.10", "3.9")) {
        try {
            $exe = (& py "-$ver" -c "import sys; print(sys.executable)" 2>$null)
            if ($exe) { return $exe.Trim() }
        } catch { }
    }
    # 3) PATH の python (バージョンガード付き)
    if (Test-PythonVersion "python") { return "python" }
    throw "Python 3.9-3.12 が見つかりません。インストールするか quaestor.config.json の ocrSidecar.venvPython にパスを指定してください (3.13+ は paddlepaddle 非対応)"
}

if (-not (Test-Path ".venv")) {
    $basePython = Resolve-VenvPython
    Write-Host "Creating virtualenv (.venv) with $basePython ..."
    & $basePython -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "venv 作成に失敗しました ($basePython)" }
} elseif (-not (Test-PythonVersion ".venv\Scripts\python.exe")) {
    throw "既存の .venv が Python 3.9-3.12 ではありません。.venv を削除して再実行してください"
}

$py = ".venv\Scripts\python.exe"
& $py -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade に失敗しました" }
& $py -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "依存のインストールに失敗しました (app_data/ocr-sidecar.log や上記出力を確認)" }

Write-Host ""
Write-Host "OCR sidecar ready. Quaestor will auto-start it (port 17350) on launch."
Write-Host "Manual run: $py -m uvicorn main:app --host 127.0.0.1 --port 17350"
