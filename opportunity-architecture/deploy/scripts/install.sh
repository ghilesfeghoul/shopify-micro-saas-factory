#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  install.sh — Opportunity Architecture                           ║
# ║                                                                   ║
# ║  Assumes opportunity-detector is already deployed (same VPS or  ║
# ║  reachable via Tailscale).                                       ║
# ║                                                                   ║
# ║  Run on a VPS that already has Docker, Tailscale, etc. (typically║
# ║  the same VPS as the detector).                                  ║
# ╚══════════════════════════════════════════════════════════════════╝

set -euo pipefail

GIT_REPO="${GIT_REPO:-https://github.com/ghilesfeghoul/shopify-micro-saas-factory.git}"
INSTALL_DIR="/opt/msf-architect"

log() { echo -e "\033[1;34m[INSTALL]\033[0m $*"; }
err() { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || err "Run as root"

# ─── Verify prerequisites ─────────────────────────────────────────
log "Checking prerequisites..."
command -v docker &>/dev/null || err "Docker not installed. Run the detector's install.sh first."
command -v git &>/dev/null || err "git not installed"

# ─── Pull repo ────────────────────────────────────────────────────
log "Cloning repo..."
mkdir -p "$INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
    cd "$INSTALL_DIR" && git pull
else
    git clone "$GIT_REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR/opportunity-architecture"

# ─── Generate secrets ─────────────────────────────────────────────
if [[ ! -f .env ]]; then
    log "Generating secrets..."
    HMAC_SECRET=$(openssl rand -hex 32)

    cat > .env <<EOF
# ─── Generated $(date -Iseconds) ───
DATABASE_URL="file:./prisma/architect.db"

LLM_BACKEND="anthropic-api"
ANTHROPIC_API_KEY="sk-ant-REPLACE-ME"
CLAUDE_MODEL="claude-opus-4-7"

HMAC_SECRET="$HMAC_SECRET"
IP_ALLOWLIST="100.64.0.0/10,172.16.0.0/12,127.0.0.1"

HOST="127.0.0.1"
PORT="3001"
NODE_ENV="production"

LOG_LEVEL="info"

DETECTOR_URL="http://detector:3000"
DETECTOR_HMAC_SECRET="REPLACE-WITH-DETECTOR-HMAC-SECRET"

AUTO_TRIGGER_SCORE_THRESHOLD="40"
POLL_LIMIT="50"
EOF
    chmod 600 .env

    log "═══════════════════════════════════════════════════════════════"
    log "BEFORE STARTING :"
    log "  1. Edit $INSTALL_DIR/opportunity-architecture/.env"
    log "  2. Set ANTHROPIC_API_KEY"
    log "  3. Set DETECTOR_HMAC_SECRET (must match detector's HMAC_SECRET)"
    log "  4. Verify DETECTOR_URL points to your detector instance"
    log "═══════════════════════════════════════════════════════════════"
    log ""
    log "Then run:"
    log "    cd $INSTALL_DIR/opportunity-architecture/deploy && docker compose up -d"
fi
