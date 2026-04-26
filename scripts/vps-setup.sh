#!/usr/bin/env bash
# One-time VPS bootstrap for serving the OIIA cat game.
#
# What it does:
#   1. Installs Node.js 20 if missing.
#   2. Installs the `serve` CLI globally (static file server).
#   3. Creates the deploy directory and grants ownership to the deploy user.
#   4. Writes a systemd unit that runs `serve` on the chosen port.
#   5. Enables + starts the service so future deploys (rsync of dist/) just
#      land into the served directory and start serving immediately.
#
# Usage:
#   ./scripts/vps-setup.sh                            # uses defaults
#   ./scripts/vps-setup.sh /var/www/oiiai 8080
#   ./scripts/vps-setup.sh <deploy-path> <port>
#
# After this runs, your GitHub Actions deploy can sudo-restart the service
# without password (we install a sudoers entry for the deploy user → systemctl).

set -euo pipefail

DEPLOY_PATH="${1:-/var/www/oiiai}"
PORT="${2:-8080}"
SERVICE_NAME="oiiai"
DEPLOY_USER="${USER}"

echo "==> OIIA cat — VPS setup"
echo "    Deploy path: $DEPLOY_PATH"
echo "    Listen port: $PORT"
echo "    Service:     ${SERVICE_NAME}.service"
echo "    Run as user: $DEPLOY_USER"
echo

# 1. Node.js (NodeSource repo if absent)
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash -
    sudo dnf install -y nodejs
  else
    echo "ERROR: Couldn't detect apt or dnf. Install Node 20+ manually." >&2
    exit 1
  fi
else
  echo "==> Node already installed: $(node --version)"
fi

# 2. `serve` (static HTTP server)
if ! command -v serve >/dev/null 2>&1; then
  echo "==> Installing 'serve' globally..."
  sudo npm install -g serve
else
  echo "==> 'serve' already installed: $(serve --version 2>/dev/null || echo present)"
fi

# 3. Deploy directory
echo "==> Preparing $DEPLOY_PATH..."
sudo mkdir -p "$DEPLOY_PATH"
sudo chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_PATH"

# Drop a placeholder so `serve` doesn't 404 before the first deploy lands.
if [ ! -f "$DEPLOY_PATH/index.html" ]; then
  cat > "$DEPLOY_PATH/index.html" <<HTML
<!doctype html>
<html><head><meta charset=utf-8><title>OIIA — booting</title></head>
<body style="font-family:system-ui;padding:2rem;color:#fff;background:#111">
<h1>OIIA cat is warming up...</h1>
<p>First deploy hasn't landed yet. Push to GitHub to trigger the build.</p>
</body></html>
HTML
fi

# 4. systemd unit
echo "==> Writing /etc/systemd/system/${SERVICE_NAME}.service..."
SERVE_BIN="$(command -v serve)"
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=OIIA cat — static game server
After=network.target

[Service]
Type=simple
User=${DEPLOY_USER}
WorkingDirectory=${DEPLOY_PATH}
# -s flag: SPA fallback to index.html on 404 (Vite SPA routing)
# -p <port>: listen port
# -L: don't log every request (keeps journalctl quiet)
ExecStart=${SERVE_BIN} -s . -p ${PORT} -L
Restart=always
RestartSec=2
# Restrict the unit a bit — read-only home except deploy path.
ProtectSystem=full
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

# 5. Sudoers: let CI restart the service without a password prompt.
SUDOERS_FILE="/etc/sudoers.d/oiiai-deploy"
echo "==> Granting passwordless systemctl restart to ${DEPLOY_USER}..."
echo "${DEPLOY_USER} ALL=(root) NOPASSWD: /bin/systemctl restart ${SERVICE_NAME}.service, /bin/systemctl status ${SERVICE_NAME}.service" \
  | sudo tee "$SUDOERS_FILE" >/dev/null
sudo chmod 0440 "$SUDOERS_FILE"

# 6. Enable + start
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.service"

# 7. Open the port in ufw if active (skip otherwise)
if sudo ufw status >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  echo "==> Opening port ${PORT}/tcp in ufw..."
  sudo ufw allow "${PORT}/tcp" || true
fi

# Final report
echo
echo "============================================================"
echo "  ✓ Setup complete."
echo "  Service:   ${SERVICE_NAME}.service ($(sudo systemctl is-active ${SERVICE_NAME}.service))"
echo "  Listening: http://$(hostname -I | awk '{print $1}'):${PORT}/"
echo
echo "  Next:"
echo "    1. Point DNS oiiai.mohamedmelekchtourou.com → this VPS IP"
echo "    2. Configure GitHub repo secrets:"
echo "         VPS_HOST          = oiiai.mohamedmelekchtourou.com (or VPS IP)"
echo "         VPS_USER          = ${DEPLOY_USER}"
echo "         VPS_SSH_KEY       = (private key text, full contents)"
echo "         VPS_DEPLOY_PATH   = ${DEPLOY_PATH}"
echo "         VPS_PORT          = ${PORT}    (used by smoke-test only)"
echo "    3. Push to GitHub → workflow rsyncs dist/ → service serves it."
echo
echo "  Visit:     http://oiiai.mohamedmelekchtourou.com:${PORT}/"
echo "  Logs:      sudo journalctl -u ${SERVICE_NAME}.service -f"
echo "  Restart:   sudo systemctl restart ${SERVICE_NAME}.service"
echo "============================================================"
