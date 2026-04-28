#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  install.sh                                                      ║
# ║                                                                   ║
# ║  Bootstraps a fresh Ubuntu 22.04+ VPS for Micro-SaaS Factory.   ║
# ║                                                                   ║
# ║  What it does:                                                   ║
# ║  1. Hardens SSH (key-only, fail2ban)                             ║
# ║  2. Configures UFW firewall (deny all, allow Tailscale + 80/443)║
# ║  3. Installs Docker + Compose                                    ║
# ║  4. Installs Tailscale and joins the tailnet                    ║
# ║  5. Generates strong secrets                                     ║
# ║  6. Pulls the repo and starts the stack                          ║
# ║                                                                   ║
# ║  Run as root on a fresh VPS:                                     ║
# ║    bash <(curl -sSL https://your-repo/install.sh)                ║
# ╚══════════════════════════════════════════════════════════════════╝

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────
GIT_REPO="${GIT_REPO:-https://github.com/YOUR_USER/micro-saas-factory.git}"
INSTALL_DIR="/opt/msf"
USERNAME="msf"

# ─── Helpers ──────────────────────────────────────────────────────
log() { echo -e "\033[1;34m[INSTALL]\033[0m $*"; }
err() { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || err "Run as root"

# ─── 1. System update + base packages ─────────────────────────────
log "Updating system..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
    curl ca-certificates gnupg lsb-release \
    ufw fail2ban \
    git unzip jq

# ─── 2. Create non-root user ──────────────────────────────────────
log "Creating user $USERNAME..."
if ! id "$USERNAME" &>/dev/null; then
    useradd -m -s /bin/bash "$USERNAME"
    usermod -aG sudo "$USERNAME"
fi

# ─── 3. SSH hardening ─────────────────────────────────────────────
log "Hardening SSH..."
SSHD_CONFIG="/etc/ssh/sshd_config.d/99-msf-hardening.conf"
cat > "$SSHD_CONFIG" <<EOF
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
UsePAM yes
X11Forwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
MaxAuthTries 3
EOF
systemctl restart sshd

# ─── 4. fail2ban ──────────────────────────────────────────────────
log "Configuring fail2ban..."
cat > /etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled = true
port = ssh
maxretry = 3
findtime = 600
bantime = 3600
EOF
systemctl restart fail2ban

# ─── 5. UFW firewall ──────────────────────────────────────────────
log "Configuring UFW..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP (Caddy redirects to HTTPS)'
ufw allow 443/tcp comment 'HTTPS'
# Tailscale interface is fully trusted
ufw allow in on tailscale0 comment 'Tailscale'
ufw --force enable

# ─── 6. Docker install ────────────────────────────────────────────
log "Installing Docker..."
if ! command -v docker &>/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    usermod -aG docker "$USERNAME"
    systemctl enable --now docker
fi

# ─── 7. Tailscale install ─────────────────────────────────────────
log "Installing Tailscale..."
if ! command -v tailscale &>/dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh
fi

log "═══════════════════════════════════════════════════════════════"
log "Tailscale needs you to authenticate."
log "Run this command and follow the URL :"
log ""
log "    sudo tailscale up --ssh"
log ""
log "Press ENTER once done..."
read -r

# ─── 8. Generate secrets ──────────────────────────────────────────
log "Generating secrets..."
mkdir -p "$INSTALL_DIR"

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    POSTGRES_PASSWORD=$(openssl rand -hex 24)
    N8N_PASSWORD=$(openssl rand -hex 16)
    N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
    DETECTOR_HMAC_SECRET=$(openssl rand -hex 32)
    TAILSCALE_HOSTNAME=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName' | sed 's/\.$//')

    cat > "$INSTALL_DIR/.env" <<EOF
# ─── Generated $(date -Iseconds) ───
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
N8N_USER=admin
N8N_PASSWORD=$N8N_PASSWORD
N8N_ENCRYPTION_KEY=$N8N_ENCRYPTION_KEY
N8N_HOST=${TAILSCALE_HOSTNAME:-n8n.local}

DETECTOR_HMAC_SECRET=$DETECTOR_HMAC_SECRET

# ─── YOU MUST FILL THIS IN ───
ANTHROPIC_API_KEY=sk-ant-REPLACE-ME
EOF
    chmod 600 "$INSTALL_DIR/.env"

    log "═══════════════════════════════════════════════════════════════"
    log "Secrets generated. Save these credentials:"
    log "  n8n URL:       https://${TAILSCALE_HOSTNAME:-n8n.local}"
    log "  n8n user:      admin"
    log "  n8n password:  $N8N_PASSWORD"
    log "═══════════════════════════════════════════════════════════════"
fi

# ─── 9. Pull repo ─────────────────────────────────────────────────
log "Cloning repo to $INSTALL_DIR..."
if [[ -d "$INSTALL_DIR/.git" ]]; then
    cd "$INSTALL_DIR" && git pull
else
    git clone "$GIT_REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ─── 10. Edit .env reminder ───────────────────────────────────────
log "═══════════════════════════════════════════════════════════════"
log "BEFORE STARTING THE STACK :"
log "  1. Edit $INSTALL_DIR/.env and set ANTHROPIC_API_KEY"
log "  2. Edit deploy/Caddyfile and replace YOUR_DOMAIN with your domain"
log "     (or use Tailscale hostname for fully private setup)"
log ""
log "Then run:"
log "    cd $INSTALL_DIR/deploy && docker compose up -d"
log "═══════════════════════════════════════════════════════════════"
