#!/usr/bin/env bash
# Herald One-Line Installer (Linux / macOS)
set -e

echo "=== Installing Herald Router, CLI, and Package ==="

# Check Python >= 3.10
if ! command -v python3 &>/dev/null; then
    echo "[Error] Python 3 is required. Please install Python 3.10 or newer."
    exit 1
fi

PY_VERSION=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
echo "[Info] Found Python $PY_VERSION"

# Create isolated user virtualenv in ~/.herald/venv
HERALD_DIR="$HOME/.herald"
VENV_DIR="$HERALD_DIR/venv"
mkdir -p "$HERALD_DIR"

if [ ! -d "$VENV_DIR" ]; then
    echo "[Info] Creating virtual environment at $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/pip" install --upgrade pip setuptools wheel
# A checkout installs itself (Router, SDK and Pi together). Otherwise install the released
# wheels from herald-release, each checked against the release manifest. Never install by
# name from PyPI: the herald names there are not ours. HERALD_WITH_PI=1 adds Herald Pi.
SRC="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
if [ -f "$SRC/pyproject.toml" ] && [ -d "$SRC/herald/router" ]; then
    "$VENV_DIR/bin/pip" install -e "$SRC"
else
    WHEELS=$("$VENV_DIR/bin/python" - <<'PY'
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
PY
)
    "$VENV_DIR/bin/pip" install $WHEELS
fi

# Create symlink in /usr/local/bin or ~/.local/bin
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "$VENV_DIR/bin/herald" "$BIN_DIR/herald"

echo "[OK] Herald installed to $BIN_DIR/herald"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo "[Note] Please ensure $BIN_DIR is in your PATH."
fi

# Launch setup wizard
"$BIN_DIR/herald" setup
