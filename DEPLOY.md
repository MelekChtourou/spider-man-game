# Deploying the OIIA cat game

The pipeline is GitHub Actions → rsync over SSH → systemd-managed `serve`
on the VPS. One-time VPS setup, push-to-deploy from there on.

## Architecture

```
push (main / claude/**)  →  GH Actions
                            • npm ci + npm run build
                            • rsync dist/ → VPS:$VPS_DEPLOY_PATH
                            • sudo systemctl restart oiiai.service
                                       │
                                       ▼
                            VPS  systemd unit
                            • runs `serve -s . -p 8080 -L`
                            • SPA fallback → index.html
                                       │
                                       ▼
                            http://oiiai.mohamedmelekchtourou.com:8080/
```

## One-time VPS setup

SSH to the VPS as the user that will own the deploy path (e.g. `ubuntu`,
`deploy`, anything but `root` is fine — the script uses `sudo` where needed):

```bash
git clone https://github.com/MelekChtourou/spider-man-game.git
cd spider-man-game
./scripts/vps-setup.sh /var/www/oiiai 8080
```

Defaults: `/var/www/oiiai`, port `8080`. Pass overrides as args.

What this does:
- Installs Node 20 (NodeSource) + the `serve` static-server CLI globally.
- Creates `/var/www/oiiai`, owned by the current user.
- Writes `/etc/systemd/system/oiiai.service` and starts it.
- Adds a passwordless sudoers entry letting that user
  `sudo systemctl restart oiiai.service` (so CI doesn't need a password).
- Opens port 8080 in ufw if ufw is active.

Once the script finishes you'll see something like:

```
✓ Setup complete.
  Listening: http://1.2.3.4:8080/
```

Visit that to confirm the placeholder page loads. Real content lands on
the first GitHub Actions deploy.

## GitHub repo secrets

In **Settings → Secrets and variables → Actions** add:

| Secret              | Value                                                       |
| ------------------- | ----------------------------------------------------------- |
| `VPS_HOST`          | `oiiai.mohamedmelekchtourou.com` (or raw VPS IP)            |
| `VPS_USER`          | The Linux user from the setup step (e.g. `ubuntu`)          |
| `VPS_SSH_KEY`       | Full private key text (begins `-----BEGIN OPENSSH KEY...`)  |
| `VPS_DEPLOY_PATH`   | `/var/www/oiiai`                                            |
| `VPS_PORT`          | `8080` (only used for the post-deploy smoke-test)           |

Generate a deploy keypair on your laptop:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/oiiai_deploy -N ""
# public key → authorize on VPS
ssh-copy-id -i ~/.ssh/oiiai_deploy.pub user@vps-ip
# private key → paste full text into VPS_SSH_KEY secret
cat ~/.ssh/oiiai_deploy
```

## DNS

Point `oiiai.mohamedmelekchtourou.com` to the VPS:

```
A    oiiai    <VPS public IPv4>
```

(Or `AAAA` if you have IPv6.) Propagation is usually a few minutes.

The site will be reachable at `http://oiiai.mohamedmelekchtourou.com:8080/`
once both DNS resolves and the workflow has run at least once.

## Deploy

Push to `main` or any `claude/**` branch — the workflow runs automatically.
You can also trigger it manually from the GitHub Actions tab via "Run
workflow".

## Troubleshooting

```bash
# Service status + logs
sudo systemctl status oiiai.service
sudo journalctl -u oiiai.service -f

# Re-deploy manually (from your laptop)
npm run build
rsync -avz dist/ user@vps:/var/www/oiiai/
sudo systemctl restart oiiai.service

# Free up the port if collision
sudo lsof -i :8080
```

## Adding HTTPS (later)

The current setup serves plain HTTP on port 8080. To get
`https://oiiai.mohamedmelekchtourou.com` (default port 443):

1. Install nginx + certbot.
2. Reverse-proxy `oiiai.mohamedmelekchtourou.com` → `127.0.0.1:8080`.
3. `certbot --nginx -d oiiai.mohamedmelekchtourou.com`.

Nginx site snippet:

```nginx
server {
  listen 80;
  server_name oiiai.mohamedmelekchtourou.com;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```
