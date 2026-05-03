#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  install.sh — Opportunity Development                            ║
# ║                                                                   ║
# ║  Assumes detector AND architect are already deployed.            ║
# ╚══════════════════════════════════════════════════════════════════╝

set -euo pipefail

GIT_REPO="${GIT_REPO:-https://github.com/ghilesfeghoul/shopify-micro-saas-factory.git}"
INSTALL_DIR="/opt/msf-development"

log() { echo -e "\033[1;34m[INSTALL]\033[0m $*"; }
err() { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || err "Run as root"

log "Checking prerequisites..."
command -v docker &>/dev/null || err "Docker not installed"
command -v git &>/dev/null || err "git not installed"

log "Cloning repo..."
mkdir -p "$INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
    cd "$INSTALL_DIR" && git pull
else
    git clone "$GIT_REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR/opportunity-development"

if [[ ! -f .env ]]; then
    log "Generating secrets..."
    HMAC_SECRET=$(openssl rand -hex 32)

    cat > .env <<EOF
# ─── Generated $(date -Iseconds) ───
DATABASE_URL="file:./prisma/development.db"

LLM_BACKEND="anthropic-api"
ANTHROPIC_API_KEY="sk-ant-REPLACE-ME"
CLAUDE_MODEL="claude-opus-4-7"

HMAC_SECRET="$HMAC_SECRET"
IP_ALLOWLIST="100.64.0.0/10,172.16.0.0/12,127.0.0.1"

HOST="127.0.0.1"
PORT="3002"
NODE_ENV="production"

LOG_LEVEL="info"

ARCHITECT_URL="http://architect:3001"
ARCHITECT_HMAC_SECRET="REPLACE-WITH-ARCHITECT-HMAC-SECRET"

APPS_ROOT="/apps"
GIT_AUTHOR_NAME="MSF Dev Agent"
GIT_AUTHOR_EMAIL="dev@micro-saas-factory.local"

MAX_PARALLEL_SUBAGENTS="3"
SKILLS_PATH=""
EOF
    chmod 600 .env

    log "═══════════════════════════════════════════════════════════════"
    log "BEFORE STARTING:"
    log "  1. Edit $INSTALL_DIR/opportunity-development/.env"
    log "  2. Set ANTHROPIC_API_KEY"
    log "  3. Set ARCHITECT_HMAC_SECRET (must match architect's HMAC_SECRET)"
    log "  4. Verify ARCHITECT_URL"
    log "═══════════════════════════════════════════════════════════════"
    log ""
    log "Then run:"
    log "    cd $INSTALL_DIR/opportunity-development/deploy && docker compose up -d"
fi
