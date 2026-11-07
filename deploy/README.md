# Deploying on Vultr

One container serves the API and the web app. Keys stay in an env file on the server and never go into the image.

## 1. Server

Create a Vultr Cloud Compute instance: Ubuntu 24.04, 2 vCPU and 4 GB, which is plenty, since simulators are light and the models run remotely. Then install Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

## 2. Build and run

```bash
git clone https://github.com/AlexWS12/livepresentationai.git tv && cd tv
cp .env.example .env   # then fill in the keys this deploy should use
docker build -t tv .
docker run -d --name tv --restart unless-stopped --env-file .env -p 8787:8787 tv
```

Open `http://<server-ip>:8787`.

Before sharing the URL, set these in the deploy's `.env`:

| Variable | Why |
|---|---|
| `RATE_LIMIT_PER_HOUR=20` | Caps AI builds, chats and recoveries per visitor, so a public link can't drain the shared Gemini and Swarms credits. Cached example prompts are free and never count. |
| `SWARMS_KEEP_USD` | Stops Swarms spending at this balance. |
| `GEMINI_API_KEY` | Give the deploy its own key, so team testing and the demo don't share one rate limit. Several comma-separated keys rotate on quota errors. |
| `GEMINI_RPM=12` | Only with a free-tier key: paces calls under its 15-a-minute limit. |
| `DESIGN_COUNCIL=on` | Optional: three Swarms architects per build. Each build then costs a Swarms run. |

The server re-reads `.env` on every API request, so after editing it, `docker restart tv` is only needed for `PORT`.

## 3. HTTPS and a domain

Point the domain's A record at the server, then put Caddy in front. It fetches certificates on its own:

```bash
sudo apt install -y caddy
echo 'your-domain.example { reverse_proxy localhost:8787 }' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy sets `X-Forwarded-For`, which the rate limit uses to tell visitors apart.

## 4. Updating

```bash
git pull && docker build -t tv . && docker rm -f tv && docker run -d --name tv --restart unless-stopped --env-file .env -p 8787:8787 tv
```

## What survives a redeploy

- **Verified designs** that ship in `apps/server/data/verified-designs.json` are part of the image.
- **Designs verified while running** (`apps/server/.cache`) and the **spend ledger** (`apps/server/.spend`) live in the container and reset on each redeploy. To keep them, mount volumes: `-v tv-cache:/app/apps/server/.cache -v tv-spend:/app/apps/server/.spend`.
