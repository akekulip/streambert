# Deploying Streambert (Web Port) on Vision

Self-hosted deployment of the Streambert web port using Docker Compose + Caddy
(automatic HTTPS). This guide targets the Linux server nicknamed **Vision**.

> [!IMPORTANT]
> **SSH access to Vision was NOT found in this build environment** — there is no
> `~/.ssh/config` entry, known host, or Tailscale alias for it here. Before you
> run any deploy step below, **confirm the actual host/alias, user, and network
> path to Vision yourself.** Nothing in this repo will (or should) SSH or deploy
> automatically. Every command below is meant to be run **on Vision**, by you.

---

## What gets deployed

Two containers, defined in `docker-compose.yml`:

| Service      | Image                | Role                                                    |
|--------------|----------------------|---------------------------------------------------------|
| `streambert` | built from `Dockerfile` | Node/Fastify server + built React frontend on port 8787 |
| `caddy`      | `caddy:2-alpine`     | TLS termination + reverse proxy (80/443 → streambert:8787) |

The app image bundles **ffmpeg** and **chromium**. It does **not** bundle the
downloader CLI (`vid-dl`) — see [Downloader binary](#downloader-binary-optional).

---

## Extractor sidecar (VidSrc Direct — optional)

The **"VidSrc Direct"** source plays movies/TV as a clean, ad-free HLS stream by
extracting the real stream server-side (headless Chrome) instead of loading
VidSrc's ad-laden embed in an iframe. It requires a third container:

| Service                | Image                          | Role                                                        |
|------------------------|--------------------------------|-------------------------------------------------------------|
| `streambert-extractor` | built from `extractor/Dockerfile` | Node + puppeteer-core + Chromium; loads the VidSrc player, mints the token, and sniffs the real `.m3u8`. **Internal only** — never published to the host. |

Build and run it on the same Docker network as the app, then point the app at it
via `STREAMBERT_EXTRACTOR_URL`:

```bash
# build (installs Chromium — a few minutes)
cd extractor && docker build -t streambert-extractor:latest .

# run on the shared network, internal-only, memory-capped + log-rotated
docker run -d --name streambert-extractor --restart unless-stopped \
  --network <your-net> --memory=1500m \
  --log-opt max-size=10m --log-opt max-file=3 \
  streambert-extractor:latest

# the app container needs this env so it can reach the sidecar:
#   STREAMBERT_EXTRACTOR_URL=http://streambert-extractor:8788
```

The stream token is bound to the extracting host's IP subnet, so the app proxies
every segment through `/api/proxy` (server-side) — the browser never fetches the
CDN directly. Results are cached ~3h. Without this container the "VidSrc Direct"
source simply fails over to another source; the rest of the app is unaffected.

**Upkeep:** VidSrc rotates its player host and changes obfuscation regularly;
when extraction breaks, rebuild the `streambert-extractor` image (the fix is
contained to `extractor/`).

---

## Prerequisites (on Vision)

- Docker Engine + the Compose plugin:
  ```bash
  docker --version
  docker compose version
  ```
  If missing, install Docker from https://docs.docker.com/engine/install/ (this
  repo does not install it for you).
- This repository checked out on Vision (e.g. `git clone` or `rsync` the folder).
- If exposing publicly: a domain with DNS pointing at Vision, and ports 80/443
  reachable.

---

## Step 1 — Get the code onto Vision

```bash
# on Vision
git clone <your-fork-url> streambert   # or rsync/scp the project directory
cd streambert
```

## Step 2 — Create the `.env` file

Create a file named `.env` **next to `docker-compose.yml`**. It is git-ignored
and must never be committed.

```dotenv
# --- Required ---------------------------------------------------------------
STREAMBERT_PASSWORD=choose-a-strong-password
STREAMBERT_COOKIE_SECRET=paste-output-of-openssl-rand-hex-32
DOMAIN=streambert.example.com

# --- Optional ---------------------------------------------------------------
# TMDB Read Access Token (the long "eyJ..." JWT). Set it to skip the in-app
# setup screen so you never re-enter it on start. See tmdb-tutorial.md.
STREAMBERT_TMDB_TOKEN=eyJ...
# ACME email for Let's Encrypt expiry notices (public-domain mode only):
TLS_EMAIL=you@example.com
# Override only if you mount the downloader binary somewhere non-default:
# STREAMBERT_DOWNLOADER=/usr/local/bin/vid-dl
```

> A `.env.example` at the repo root has these same keys — `cp .env.example .env`
> to start from it.

Generate a strong cookie secret:

```bash
openssl rand -hex 32
```

### Environment variables reference

| Variable                   | Required | Default (image)          | Purpose |
|----------------------------|----------|--------------------------|---------|
| `STREAMBERT_PASSWORD`      | ✅       | —                        | Login password for the single-user web app. |
| `STREAMBERT_COOKIE_SECRET` | ✅       | (dev fallback; change it)| Secret that signs the session cookie. |
| `DOMAIN`                   | ✅       | —                        | Caddy site address (public domain, or LAN host/IP for `tls internal`). |
| `STREAMBERT_SECURE_COOKIES` | ✅ (public) | (none) | Set to `1` on any public deployment to force the `Secure` cookie flag regardless of the (client-spoofable) `X-Forwarded-Proto` header. |
| `STREAMBERT_ADMIN_USER`     | ➖       | `admin`                  | Username for the first-run bootstrap admin (only when the user DB is empty). |
| `STREAMBERT_ADMIN_PASSWORD` | ➖       | (`STREAMBERT_PASSWORD`)  | Password for the bootstrap admin; falls back to `STREAMBERT_PASSWORD`. |
| `STREAMBERT_TMDB_TOKEN`    | ➖       | (none)                   | TMDB Read Access Token. Set it to pre-seed the key and skip the in-app setup screen; a token saved in the app overrides it. |
| `TLS_EMAIL`                | ➖       | (none)                   | ACME email for Let's Encrypt notices. |
| `STREAMBERT_DOWNLOADER`    | ➖       | `/usr/local/bin/vid-dl`  | Path to the downloader CLI inside the container. |
| `STREAMBERT_DATA`          | (set)    | `/data`                  | Set to `/data` by compose; persisted via `./data`. |
| `PORT`                     | (set)    | `8787`                   | Server port; keep in sync with the Caddyfile upstream. |

> **Login is now per-user.** On first start an admin account is created (see the
> two vars above; by default `admin` + `STREAMBERT_PASSWORD`). Create additional
> users in Settings → Users. `STREAMBERT_PASSWORD` is retained only for the
> initial admin bootstrap.

## Step 3 — Choose a networking / TLS mode

Pick **one** of the three. This only affects `DOMAIN` and one line in the
`Caddyfile`; the built image is identical.

### Option A — Public domain (automatic HTTPS)
Best when Vision is reachable from the internet and you own a domain.
1. Point the domain's DNS **A/AAAA** record at Vision's public IP.
2. Make sure ports **80** and **443** reach Vision (router port-forward / firewall).
3. In `.env`: `DOMAIN=streambert.example.com` (and optionally `TLS_EMAIL`).
4. Leave the `Caddyfile` as-is — Caddy fetches a real Let's Encrypt cert on first start.

### Option B — Tailscale (private mesh, recommended for personal use)
No public exposure; reach Vision over your tailnet from phone/laptop/iPad.
1. Install Tailscale on Vision and your devices; note Vision's tailnet name/IP
   (e.g. `vision.tailnet-name.ts.net` or `100.x.y.z`).
2. In `.env`: `DOMAIN=vision.tailnet-name.ts.net` (MagicDNS) **or** the `100.x.y.z` IP.
3. In `Caddyfile`, uncomment `tls internal` (self-signed) — **or**, if you use
   Tailscale HTTPS/MagicDNS certs, keep automatic HTTPS with the `*.ts.net` name.
4. With `tls internal`, install Caddy's root CA on each device (see
   [Trusting the internal CA](#trusting-the-internal-ca)).

### Option C — LAN only (self-signed)
Home network access by hostname/IP, no internet exposure.
1. In `.env`: `DOMAIN=vision.local` (or the LAN IP, e.g. `192.168.1.50`).
2. In `Caddyfile`, uncomment `tls internal`.
3. Install Caddy's root CA on each device so Safari/Chrome accept HTTPS.

> iOS/Safari require **HTTPS** for the app's features (secure context). Plain
> HTTP on `:8787` works only for quick local testing, not from iPhones/iPads.

## Step 4 — Build and start

```bash
# on Vision, in the project root
docker compose up -d --build
```

Watch the logs on first start (cert issuance, server boot):

```bash
docker compose logs -f
docker compose ps
```

## Step 5 — Reach it

- **Option A:** `https://streambert.example.com`
- **Option B:** `https://vision.tailnet-name.ts.net` (or `https://100.x.y.z`)
- **Option C:** `https://vision.local` (or `https://192.168.1.50`)

Log in with `STREAMBERT_PASSWORD`.

### Trusting the internal CA
When using `tls internal`, export Caddy's root and install it on your devices:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```
- **iOS/iPadOS:** AirDrop/email `caddy-root.crt` → install profile →
  Settings ▸ General ▸ About ▸ Certificate Trust Settings ▸ enable full trust.
- **macOS:** add to Keychain, set to *Always Trust*.
- **Android/Windows/Linux:** import into the system/user trust store.

---

## Where data persists

Everything durable lives in the host bind-mount **`./data`** (mapped to `/data`
in the container via `STREAMBERT_DATA`):

- **Downloads** — saved media files.
- **Secure key store** — server-side JSON for TMDB/Wyzie/SubDL keys
  (`GET/PUT /api/secure/:key`).

Caddy's TLS certificates persist in the named volume **`caddy_data`** (so you
don't re-issue certs on every restart).

**Back up** `./data` (and optionally `caddy_data`) to preserve downloads, keys,
and certificates.

## Downloader binary (optional)

The image installs `ffmpeg` and `chromium` but **not** the downloader CLI
(`vid-dl` / `vid-dl-cli-only`). Downloads stay non-functional until you provide
it; nothing else is affected and the build never fails without it.

Provide it one of two ways:

1. **Mount from the host** — put the binary at `./bin/vid-dl` on Vision and
   uncomment this line in `docker-compose.yml`:
   ```yaml
   - ./bin/vid-dl:/usr/local/bin/vid-dl:ro
   ```
   Make sure it's executable and built for the container's arch (linux/amd64):
   `chmod +x ./bin/vid-dl`.
2. **Point at a different path** — set `STREAMBERT_DOWNLOADER=/path/inside/container`
   in `.env` and mount accordingly.

The server reads the path from `STREAMBERT_DOWNLOADER` (default
`/usr/local/bin/vid-dl`).

---

## Updating / redeploying

```bash
# on Vision
cd streambert
git pull                       # or re-sync the code
docker compose up -d --build   # rebuild image, recreate changed containers
docker image prune -f          # optional: reclaim old layers
```

`./data` and `caddy_data` survive rebuilds, so downloads, keys, and certs are
preserved.

## Common operations

```bash
docker compose logs -f streambert     # app logs
docker compose logs -f caddy          # proxy / TLS logs
docker compose restart streambert     # restart just the app
docker compose down                   # stop & remove containers (keeps volumes)
docker compose down -v                # ALSO delete named volumes (caddy certs!)
```

## Troubleshooting

- **Cert won't issue (Option A):** DNS not pointing at Vision, or ports 80/443
  not reachable. Check `docker compose logs caddy`.
- **Browser warns "not secure" (Options B/C):** expected with `tls internal`
  until you install Caddy's root CA (see above).
- **`STREAMBERT_PASSWORD is not set` on `up`:** create/fix `.env` (Step 2).
- **Login works but downloads fail:** the downloader binary isn't present — see
  [Downloader binary](#downloader-binary-optional).
- **Health check unhealthy:** the frontend didn't build or the server didn't
  start — check `docker compose logs streambert`.
