# Herald One-Line Installer (Windows PowerShell)
$ErrorActionPreference = "Stop"

Write-Host "=== Installing Herald Router, CLI, and Package ===" -ForegroundColor Cyan

# Check Python
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) {
    Write-Error "Python 3 is required. Please install Python 3.10+ from python.org or the Microsoft Store."
}

$heraldDir = Join-Path $HOME ".herald"
$venvDir = Join-Path $heraldDir "venv"
if (-not (Test-Path $heraldDir)) {
    New-Item -ItemType Directory -Path $heraldDir | Out-Null
}

if (-not (Test-Path $venvDir)) {
    Write-Host "[Info] Creating virtual environment at $venvDir..." -ForegroundColor Yellow
    python -m venv $venvDir
}

$pip = Join-Path $venvDir "Scripts\pip.exe"
$heraldExe = Join-Path $venvDir "Scripts\herald.exe"

& $pip install --upgrade pip setuptools wheel
# A checkout installs itself (Router, SDK and Pi together). Otherwise install the released
# wheels from herald-release, each checked against the release manifest. Never install by
# name from PyPI: the herald names there are not ours. $env:HERALD_WITH_PI = "1" adds Herald Pi.
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "herald\router"))) {
    & $pip install -e $PSScriptRoot
} else {
    $fetch = @'
import hashlib, json, os, sys, tempfile, urllib.request
base = "https://github.com/KianJRoss/herald-release/releases/latest/download/"
manifest = json.load(urllib.request.urlopen(base + "release-manifest.json"))
wanted = {"herald-router", "herald-sdk"} | ({"herald-pi"} if os.environ.get("HERALD_WITH_PI") == "1" else set())
out = tempfile.mkdtemp(prefix="herald-")
for product in manifest["products"]:
    if product["name"] not in wanted:
        continue
    wheel = next(f for f in product["files"] if f["name"].endswith(".whl"))
    data = urllib.request.urlopen(base + wheel["name"]).read()
    if hashlib.sha256(data).hexdigest() != wheel["sha256"]:
        sys.exit(wheel["name"] + " does not match its published checksum")
    path = os.path.join(out, wheel["name"])
    open(path, "wb").write(data)
    print(path)
'@
    $wheels = $fetch | & (Join-Path $venvDir "Scripts\python.exe") -
    if ($LASTEXITCODE -ne 0) { throw "Could not download a verified Herald release." }
    & $pip install @($wheels -split "`r?`n" | Where-Object { $_ })
}

Write-Host "[OK] Herald installed successfully!" -ForegroundColor Green
Write-Host "[Info] Launching Setup Wizard..." -ForegroundColor Cyan
& $heraldExe setup
