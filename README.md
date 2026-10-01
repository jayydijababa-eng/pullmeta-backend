# PullMeta Backend

High-performance, containerized YouTube video downloader, audio extractor, and metadata inspection service built with Next.js App Router, yt-dlp, and FFmpeg.

---

## Overview & Features

PullMeta Backend is a dedicated, **YouTube-only** media processing engine designed for serverless and container deployments (Railway, Render, Hugging Face, or self-hosted Docker):

- **YouTube-Only Architecture:** Tailored strictly for YouTube URLs (`watch`, `shorts`, `youtu.be`, and live stream archives).
- **Verified Full HD & 4K Quality:** Dynamic stream probing via `yt-dlp` returns honest available resolutions (144p to 4K 2160p) with actual filesize approximations.
- **Lossless & High-Bitrate Audio:** Extracts pure audio streams transcoded to universally compatible MP3 (320kbps, 256kbps, 128kbps) or native M4A/AAC without re-encoding video.
- **FFmpeg & FFprobe Verification:** Merges adaptive video and audio streams into standard MP4 containers with universally playable AAC audio, verified via `ffprobe` prior to client delivery.
- **Enterprise Cookie Authentication:** Resolves YouTube's datacenter bot checks via environment variable `YOUTUBE_COOKIES` with support for both Netscape format and JSON array exports.
- **Isolated Request Sandboxing:** Every download runs in an isolated temporary directory with a scoped, single-use cookie file that is automatically purged immediately upon completion.
- **Proxy Support:** Optional residential or datacenter proxy integration via `PROXY_URL` to route requests through clean IP addresses.
- **Health & Readiness Check:** `/api/health` exposes sanitized booleans (`cookiesLoaded`, `proxyConfigured`, `ytDlpVersion`, `hasFfmpeg`) without leaking sensitive tokens.

---

## Tech Stack

- **Runtime & Framework:** Node.js 20 LTS, Next.js 16 (App Router Route Handlers)
- **Language:** TypeScript 5 (Strict Mode)
- **Media Engine:** `yt-dlp` (Latest upstream standalone release)
- **Audio/Video Transcoder:** `ffmpeg` & `ffprobe`
- **JavaScript Challenge Solver:** Node.js (`--js-runtimes node`)
- **Testing & Quality:** Vitest 3, TypeScript compiler (`tsc --noEmit`)
- **Deployment:** Railway / Docker (`node:20-bookworm-slim`)

---

## Local Setup & Running

### Prerequisites
1. **Node.js** >= 18.18.0 (Node 20+ recommended)
2. **FFmpeg & FFprobe** installed and available in system `PATH`
3. **yt-dlp** installed or placed in `bin/` or system `PATH`

### Installation
```bash
# Clone the repository
git clone https://github.com/jayydijababa-eng/pullmeta-backend.git
cd pullmeta-backend

# Install dependencies
npm install

# Copy environment variable template
cp .env.example .env

# Run development server (runs on Port 4000)
npm run dev
```

### Running Tests & Linting
```bash
# Run unit and integration tests (Vitest)
npm test

# Run TypeScript typecheck
npm run lint
```

---

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `YOUTUBE_COOKIES` | Optional | *None* | YouTube authentication cookies in Netscape `cookies.txt` or JSON array format. Bypasses datacenter bot checks on cloud servers. |
| `PROXY_URL` | Optional | *None* | Optional HTTP/HTTPS/SOCKS5 proxy URL (e.g. `http://user:pass@proxy.example.com:8080`). Routed directly to yt-dlp. |
| `YOUTUBE_PLAYER_CLIENT` | Optional | `visionos,android,mweb` | Client identifiers passed to yt-dlp extractor args. `visionos,android,mweb` bypasses web JS challenges out-of-the-box. |
| `PORT` | Optional | `4000` | Port on which the backend server listens (dynamically set by Railway/Render). |
| `NODE_ENV` | Optional | `development` | Server runtime environment (`production` or `development`). |
| `NEXT_PUBLIC_APP_URL` | Optional | `http://localhost:3000` | Origin URL of the frontend application allowed for CORS requests. |
| `MAX_FILE_SIZE_BYTES` | Optional | `5368709120` (5 GB) | Hard ceiling on downloaded media size to prevent storage exhaustion. |
| `DOWNLOAD_TIMEOUT_MS` | Optional | `600000` (10 min) | Max processing duration before aborting stalled downloads. |
| `MAX_CONCURRENT_DOWNLOADS` | Optional | `5` | Maximum simultaneous download slots processed in memory. |

---

## How to Export YouTube Cookies

To bypass YouTube's datacenter bot protection reliably on cloud servers, provide cookies from an active session:

1. **Use a Separate Account:** Never use your personal, primary Google account. Create or use a dedicated burner/non-primary Google account.
2. **Open an Incognito/Private Window:** Launch a fresh private browser window.
3. **Log In to YouTube:** Go to [youtube.com](https://www.youtube.com) and sign in with the secondary account.
4. **Open Robots Text:** Navigate to `https://www.youtube.com/robots.txt` in the same tab (this ensures cookies are persisted without background trackers writing ephemeral session markers).
5. **Export Cookies:** Open a trusted cookie export extension (such as **"Get cookies.txt LOCALLY"** or **"Cookie-Editor"**):
   - **Netscape format:** Choose "Export as cookies.txt"
   - **JSON format:** Choose "Export as JSON"
6. **Close the Private Window:** Close the incognito window **without clicking Log Out**. (Clicking Log Out invalidates the session keys immediately on Google's servers).

---

## How to Deploy on Railway & Set Cookies

1. **Link Repository on Railway:**
   - In your [Railway Dashboard](https://railway.app), create a new project from your backend GitHub repository (`pullmeta-backend`).
   - Railway will automatically detect `Dockerfile` or `railway.json`.

2. **Configure Environment Variables:**
   - Go to your service **Variables** tab.
   - Click **New Variable** -> enter name `YOUTUBE_COOKIES`.
   - In the value box, paste the raw content of your exported cookies (either the multi-line Netscape text or the raw JSON array). Railway natively preserves multi-line string variables.
   - *(Optional)* Add `PROXY_URL` if routing through a residential or datacenter proxy.
   - Set `NEXT_PUBLIC_APP_URL` to your production frontend URL (e.g. `https://pullmeta.com`).

3. **Deploy & Verify:**
   - Click **Deploy**.
   - Inspect build and deployment logs:
     ```
     [Startup Check] FFmpeg verified: /usr/bin/ffmpeg
     [Startup Check] yt-dlp verified: /usr/local/bin/yt-dlp
     [YouTube Cookies] Successfully initialized and secured authentication cookies at server startup.
     ```
   - Query the health endpoint to confirm status:
     ```bash
     curl https://your-backend.railway.app/api/health
     # Returns: {"ok":true,"cookiesLoaded":true,"proxyConfigured":false,"ytDlpVersion":"2026.08.19","hasFfmpeg":true}
     ```

---

## Troubleshooting

### "Bot / Sign-in Check" Error
- **Cause:** YouTube actively monitors IP ranges assigned to major cloud hosting providers (AWS, GCP, Railway, DigitalOcean, Hetzner). When requests originate from datacenter subnets using unauthenticated web clients, YouTube returns a challenge: `Sign in to confirm you're not a bot`.
- **Resolution:**
  1. Ensure `YOUTUBE_COOKIES` is configured in Railway with fresh cookies exported from an incognito session.
  2. PullMeta automatically sets `YOUTUBE_PLAYER_CLIENT=visionos,android,mweb` and `--js-runtimes node`, which avoids web challenges by default.
  3. If cloud hosting IP ranges become aggressively blacklisted, configure `PROXY_URL` with a residential proxy provider.

### "Rate limit exceeded" Error
- **Cause & Diagnosis:**
  1. **Application Rate Limiter:** The backend limits requests per client IP. Behind reverse proxies (like Railway, Cloudflare, or Vercel), if `X-Forwarded-For` or `CF-Connecting-IP` is misread or requests default to `127.0.0.1`, all visitors share the same rate-limit bucket.
  2. **YouTube 429 Too Many Requests:** When too many concurrent or rapid extraction/download calls originate from the same cloud IP address, YouTube responds with HTTP 429 / "Too Many Requests".
- **Resolution & Protections:**
  1. **Proxy-Aware Real Client IP Extraction:** The backend inspects `CF-Connecting-IP`, `X-Real-IP`, `True-Client-IP`, `X-Client-IP`, and filters internal hops from `X-Forwarded-For` to isolate genuine client IPs.
  2. **Sensible Default Limits:** Default limits are set to **20 downloads per IP per 15 minutes** (customizable via `RATE_LIMIT_DOWNLOAD_MAX`) and **30 extract requests per 15 minutes** (`RATE_LIMIT_EXTRACT_MAX`).
  3. **Concurrent Job Queue:** Limits concurrent `yt-dlp` jobs to **2-3** (via `MAX_CONCURRENT_DOWNLOADS=3`). Excess requests wait safely in an asynchronous FIFO queue instead of immediately failing.
  4. **Video Info Caching:** Video metadata and format probing results are cached in-memory for 10 minutes (`DEFAULT_TTL_MS = 10 * 60 * 1000`). Repeated extractions/downloads for the same video are served instantly without spawning `yt-dlp`.
  5. **Request Spacing (`--sleep-requests`):** Sub-requests are spaced with `--sleep-requests 1.5` so YouTube endpoints are not hammered in sub-seconds.
  6. **Residential Proxy:** If cloud hosting IPs are persistently rate-limited by YouTube, configure `PROXY_URL` with a residential proxy provider.

### Cookies Expiring
- Google cookie sessions typically remain valid for several weeks or months unless logged out.
- If downloads begin failing with temporary unavailability errors, re-export fresh cookies from your burner account following the steps above and update the `YOUTUBE_COOKIES` variable in Railway.

---

## Security Notes

- **Never Commit Cookies:** Never store cookies in code, files committed to Git, or public issue trackers. Keep `.gitignore` updated.
- **Use Burner Accounts:** Always use an isolated, non-primary Google account for exporting cookies.
- **Auto-Rotation & Invalidation:** If cookies are ever accidentally exposed, immediately log out of the Google account across all devices to revoke all active session tokens.
- **Sanitized Client Errors:** The backend sanitizes all technical errors. Internal paths, proxy credentials, and cookie details are logged strictly server-side and never returned to the frontend.

---

## Legal Disclaimer

PullMeta and PullMeta Backend are open-source software tools developed strictly for educational, archival, and fair-use purposes. Users are solely responsible for ensuring that their downloads comply with YouTube's Terms of Service, applicable copyright laws, and intellectual property rights in their jurisdiction. The developers and contributors do not host, store, or distribute copyrighted video or audio content.
