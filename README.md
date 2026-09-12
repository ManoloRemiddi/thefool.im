# thefool.im — Major Arcana

A three-page website for browsing, studying, and reading the 22 Major Arcana
tarot cards:

- **The Cards** (`index.html`) — visual gallery: all 22 cards as tiles; click
  one for the large image plus a short meaning and a "Key Elements" list of
  the image's symbols.
- **How to Read** (`how-to-read.html`) — a guide to reading just the 22 Major
  Arcana: single cards, the Fool's Journey stages, spreads, upright vs.
  reversed.
- **AI Card Reader** (`ai-reader.html`) — draw random cards (they land
  face-down and flip face-up) and get a streamed AI reading: one section per
  card plus an overall message. Visitors need no key and pay nothing.

Live at **https://thefool.im** (and `www.thefool.im`). Card images courtesy
of [historyoftarot.com](https://www.historyoftarot.com/major-arcana/)
(public domain).

---

## Repository layout

```
index.html, how-to-read.html, ai-reader.html   the three pages
css/   js/   images/ (+ images/thumb/)        site assets
CNAME                                "thefool.im" → custom domain for Pages
server.py                            the proxy server (see below)
README.md                            this file
```

This repo is deployed by **GitHub Pages** (public repo, free tier, automatic
SSL). Pages serves the HTML/CSS/JS as static files from the `main` branch
root; `server.py` is *not* used by Pages — it runs on the NAS (below).

## How the AI reader works (architecture)

Two hosts, one visitor flow:

```
Visitor's browser
│
├─ https://thefool.im  ────────────►  GitHub Pages (this repo, static files)
│                                       serves the site, free automatic SSL
│
└─ POST https://augmentor.tail1ce34f.ts.net:8443/tarot/api/read
        (cross-origin; allowed via CORS headers on the proxy)
        │
        ▼
   Tailscale Funnel (NAS, port 8443, Let's Encrypt cert via *.ts.net)
        │
        ▼
   Caddy container `tarot-proxy` (host network, port 8810)
        │  handle_path /tarot/*  → reverse proxy
        ▼
   Container `tarot-website` (python:3.12-slim, port 8811)
        ├─ serves a copy of this site at /tarot/ (backup access point)
        └─ /api/read: validates the request, adds the API key
           (read at startup from /secrets.env — never sent to the browser),
           streams MiniMax M3 back as Server-Sent Events
```

Key properties:

- **The API key is server-side only.** It is read from
  `/secrets.env` inside the `tarot-website` container (mounted read-only
  from `~/tarot-secrets.env` on the NAS, mode 600). It never reaches the
  browser, the logs, or this repository.
- **Visitors pay nothing** — readings are billed to the owner's MiniMax
  account (a few cents per 1000 readings with MiniMax-M3).
- **Rate limiting** protects the owner's credits: 15 readings per IP per
  hour (env-configurable, see below). `OPTIONS` preflights don't consume
  the limit.
- **Cross-origin** is what makes this possible: the page lives on
  `thefool.im` (GitHub Pages), the proxy lives on the NAS (Tailscale
  Funnel). The proxy answers preflights with 204 and echoes the request
  `Origin` in `Access-Control-Allow-Origin` (`server.py: do_OPTIONS`).
  `js/reader.js` picks the endpoint by hostname: on `thefool.im` /
  `*.github.io` it calls the public NAS URL; on the NAS or locally it
  uses the same-origin relative path `api/read`.

## Environment variables (`server.py`)

| Variable             | Default            | Purpose                          |
|----------------------|--------------------|----------------------------------|
| `TAROT_HOST`         | `127.0.0.1`        | bind address (`0.0.0.0` in Docker) |
| `TAROT_PORT`         | `8811`             | listen port                      |
| `TAROT_SECRETS_FILE` | `~/.dsh/secrets.env` | file holding `MINIMAX_API_KEY=` |
| `TAROT_RATE_LIMIT`   | `15`               | max readings per IP per window   |
| `TAROT_RATE_WINDOW`  | `3600`             | window in seconds                |

## Running locally (on MX)

```bash
cd <this repo>
python3 server.py        # http://127.0.0.1:8811
```

The key is loaded from `~/.dsh/secrets.env` (line `MINIMAX_API_KEY=...`).
If it's missing the site still works; readings return an error.

## Updating the site (pages, CSS, JS, images)

1. Edit files in this repo.
2. `git add -A && git commit -m "..." && git push`
3. GitHub Pages redeploys automatically (about a minute).

**Also sync to the NAS** if you want the `ts.net` backup URL to match
(the NAS container has its own baked-in copy of the site):

```bash
# from the repo root on MX — sync ALL site files (NOT server.py-only)
tar czf - index.html how-to-read.html ai-reader.html css js images \
  | ssh r-nas1 'tar xzf - -C ~/tarot-website'
ssh r-nas1 'cd ~/tarot-website && sudo docker build -q -t tarot-website . \
  && sudo docker stop tarot-website && sudo docker rm tarot-website \
  && sudo docker run -d --name tarot-website -p 8811:8811 \
      -v /home/manolo/tarot-secrets.env:/secrets.env:ro \
      --restart unless-stopped tarot-website'
```

(Note: if you add a **new HTML page**, also add its filename to the
`COPY` line in `~/tarot-website/Dockerfile` on the NAS, or the NAS copy
won't serve it.)

## Updating the proxy (`server.py`)

1. Edit `server.py`, test locally: `python3 server.py` then
   `curl -i -X OPTIONS -H "Origin: https://thefool.im" \
    -H "Access-Control-Request-Method: POST" http://127.0.0.1:8811/api/read`
   → expect `204` with `access-control-*` headers.
2. Deploy to the NAS:

```bash
tar czf - server.py | ssh r-nas1 'tar xzf - -C ~/tarot-website'
ssh r-nas1 'cd ~/tarot-website && sudo docker build -q -t tarot-website . \
  && sudo docker stop tarot-website && sudo docker rm tarot-website \
  && sudo docker run -d --name tarot-website -p 8811:8811 \
      -v /home/manolo/tarot-secrets.env:/secrets.env:ro \
      --restart unless-stopped tarot-website'
```

## Adding a new page (recipe)

1. Create `new-page.html` — copy the structure of `index.html` (same
   `<header>` nav, same `<footer>`, link `css/style.css` and the JS you need).
2. Add the new page to the **nav of every existing page** (the nav is
   hardcoded per page — update `index.html`, `how-to-read.html`,
   `ai-reader.html` and the new page itself).
3. `git add -A && git commit && git push` — live in ~1 minute.
4. Sync to the NAS (recipe above) + add the filename to the NAS
   `Dockerfile` `COPY` line.

## Production URLs

| URL | What |
|-----|------|
| `https://thefool.im` | the site (GitHub Pages, primary) |
| `https://www.thefool.im` | CNAME → thefool.im (redirects to apex) |
| `https://augmentor.tail1ce34f.ts.net:8443/tarot/` | same site on the NAS + the API endpoint (backup access point) |

## DNS (managed at Spaceship, domain `thefool.im`)

| Host | Type | Value |
|------|------|-------|
| `@`  | A    | `185.199.108.153` |
| `@`  | A    | `185.199.109.153` |
| `@`  | A    | `185.199.110.153` |
| `@`  | A    | `185.199.111.153` |
| `www`| CNAME| `thefool.im` |

These four A records are GitHub Pages' fixed IPs. GitHub auto-issues the
SSL certificate once DNS checks pass, and "Enforce HTTPS" is on in the
repo's Pages settings.

## NAS pieces (R-NAS1)

- `~/tarot-website/` — site copy + `Dockerfile` (python:3.12-slim, copies
  the site, sets `TAROT_HOST/TAROT_PORT/TAROT_SECRETS_FILE`)
- `~/tarot-proxy/Caddyfile` — `http://:8810` with
  `handle_path /tarot/* → 127.0.0.1:8811` and `/ → 127.0.0.1:8081`
  (UGOS public-folder service passthrough, preserved)
- `~/tarot-secrets.env` — `MINIMAX_API_KEY=...` (mode 600; **never commit,
  never print**)
- Containers: `tarot-website` (`-p 8811:8811`, secrets mount, restart
  unless-stopped) and `tarot-proxy` (Caddy, `--network host`, restart
  unless-stopped)
- Tailscale Funnel: listener on 8443 → `127.0.0.1:8810`
  (Let's Encrypt cert for `*.ts.net` handled by Tailscale)

## Troubleshooting

- **Site down at thefool.im** → repo Settings → Pages (build status);
  `dig thefool.im A` should show the four IPs above.
- **Readings fail from the browser** → the page's console shows the exact
  fetch error; check the NAS container (`sudo docker ps`,
  `sudo docker logs tarot-website`), then the funnel
  (`curl -i -X OPTIONS -H "Origin: https://thefool.im"
  https://augmentor.tail1ce34f.ts.net:8443/tarot/api/read` → expect 204).
- **Rate-limited** → 429 after 15 readings/IP/hour; expected behaviour.
- **Browser tests from a tailnet machine block the API call** →
  Chromium's Private Network Access policy: a tailnet member sees the
  `*.ts.net` endpoint as a local address. Test from a public network
  (e.g. phone on mobile data).
- **After DNS changes** → give it a few minutes; `dig` the apex and www
  directly against `launch1.spaceship.net` to check the source of truth.

## Backups

- This repo on GitHub (cloud copy, versioned history) — primary backup.
- Local working copy on MX.
- NAS holds its own deployment copy of the site + proxy.
- The only thing *not* in any repo is the API key (by design); it lives
  in the two secrets files named above.
