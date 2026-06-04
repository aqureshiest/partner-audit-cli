#!/usr/bin/env bash
# install.sh — one-shot setup for partner-audit-cli on a fresh Mac
# Usage:  curl -fsSL https://<your-host>/install.sh | bash
# Or:     REPO_URL=git@github.com:org/repo.git bash install.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/aqureshiest/partner-audit-cli.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/partner-audit-cli}"
NODE_MIN=20

GRN='\033[0;32m'; YLW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GRN}==>${NC} $*"; }
warn() { echo -e "${YLW}WARN:${NC} $*"; }
die()  { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "This installer targets macOS. For Linux, set up Node + Playwright manually."

# ── Homebrew ────────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
    log "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to PATH for the rest of this script (Apple Silicon path)
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
fi

# ── Node.js ─────────────────────────────────────────────────────────────────
if command -v node &>/dev/null; then
    current=$(node -v | sed 's/v//' | cut -d. -f1)
    if [[ "$current" -ge "$NODE_MIN" ]]; then
        log "Node.js $(node -v) already satisfies >= $NODE_MIN"
    else
        log "Upgrading Node.js (found $current, need $NODE_MIN)..."
        brew upgrade node || brew install node
    fi
else
    log "Installing Node.js via Homebrew..."
    brew install node
fi
log "Node $(node -v) / npm $(npm -v)"

# ── Repo ─────────────────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
    log "Repo already at $INSTALL_DIR — pulling latest..."
    git -C "$INSTALL_DIR" pull --ff-only
else
    log "Cloning $REPO_URL → $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ── npm deps ─────────────────────────────────────────────────────────────────
log "Installing npm dependencies..."
npm ci 2>/dev/null || npm install

# ── Playwright Chromium ──────────────────────────────────────────────────────
log "Downloading Playwright Chromium..."
npx playwright install chromium

# Locate the binary Playwright just downloaded
chromium_bin=$(find "$HOME/Library/Caches/ms-playwright" \
    -name "chrome" -path "*/chromium-*/*" -type f 2>/dev/null | head -1 || true)

# ── .env setup ───────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    cp .env.example .env
    log "Created .env from .env.example"
fi

if [ -n "$chromium_bin" ]; then
    if grep -q "^CHROME_PATH=" .env; then
        sed -i '' "s|^CHROME_PATH=.*|CHROME_PATH=$chromium_bin|" .env
    elif grep -q "^# CHROME_PATH=" .env; then
        sed -i '' "s|^# CHROME_PATH=.*|CHROME_PATH=$chromium_bin|" .env
    else
        echo "CHROME_PATH=$chromium_bin" >> .env
    fi
    log "CHROME_PATH → $chromium_bin"
else
    warn "Could not locate Playwright Chromium binary; set CHROME_PATH in .env manually."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  partner-audit-cli installed at $INSTALL_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Set your AWS Bedrock bearer token:"
echo "       cd $INSTALL_DIR && nano .env"
echo "       # set AWS_BEARER_TOKEN_BEDROCK=<your-token>"
echo ""
echo "  2. Run:"
echo "       cd $INSTALL_DIR && npm run audit"
echo "       npm run audit -- --partner \"SoFi\"   # single partner"
echo "       npm run audit -- --output csv        # export CSV"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
