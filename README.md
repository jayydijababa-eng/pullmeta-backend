# PullMeta Backend

High-performance, containerized YouTube video downloader, audio extractor, and metadata inspection service built with Next.js App Router, BullMQ + Redis, yt-dlp, and FFmpeg.

---

## Overview & Features

PullMeta Backend is an enterprise-grade, **YouTube-only** media processing engine designed for both single-container hosting and large-scale (1,000+ concurrent users) distributed deployments on Railway, Render, AWS, or self-hosted Docker:

- **YouTube-Only Architecture:** Tailored strictly for YouTube URLs (`watch`, `shorts`, `youtu.be`, and live stream archives).
- **Verified Full HD & 4K Quality:** Dynamic stream probing via `yt-dlp` returns honest available resolutions (144p to 4K 2160p) with actual filesize approximations. Min dimension check (`min(width, height)`) accurately detects vertical Shorts without resolution distortion.
- **Lossless & High-Bitrate Audio:** Extracts pure audio streams transcoded to universally compatible MP3 (320kbps, 256kbps, 128kbps) or native M4A/AAC without re-encoding video.
- **FFmpeg & FFprobe Verification:** Merges adaptive video and audio streams into standard MP4 containers with universally playable AAC audio, verified via `ffprobe` prior to client delivery.
- **1,000+ Concurrent Scaling (Distributed Mode):**
  - **Decoupled Stateless Web & Workers:** Next.js API servers handle user traffic, while 2–4+ standalone worker containers run yt-dlp + FFmpeg.
  - **BullMQ + Redis Distributed Queue:** Coordinates downloads across any number of worker containers without race conditions or memory bottlenecks.
  - **Distributed Request Coalescing:** When 100 users request the same viral video at the same time, it is downloaded only once; all 100 users receive the stream simultaneously.
  - **Cloud Object Storage (Cloudflare R2 / S3):** Finished downloads are offloaded to Cloudflare R2 ($0 egress fees) with direct pre-signed edge download URLs, completely relieving backend network bandwidth.
  - **Zero-Config Local Fallback:** When Redis or S3 are not configured, seamlessly falls back to the built-in in-memory FIFO queue and local disk cache for development and single-container deployments.
- **Enterprise Anti-Bot & Cookie Authentication:** Resolves YouTube's datacenter bot checks via environment variable `YOUTUBE_COOKIES` (Netscape or JSON format), paired with Deno + Node 22 for EJS JavaScript challenge solving.
- **Isolated Request Sandboxing:** Every download runs in an isolated temporary directory with a scoped, single-use cookie file that is automatically purged immediately upon completion.
- **Disk Protection Ceiling:** Real-time disk monitoring halts new jobs if storage exceeds 92% capacity or free space drops below 500 MB.
- **Health & Readiness Check:** `/api/health` exposes sanitized system metrics (`queueDriver`, `storageDriver`, `redisConfigured`, `s3Configured`, `cookiesLoaded`, `proxyConfigured`, `ytDlpVersion`, `hasFfmpeg`) without leaking private tokens.

---

## Tech Stack

- **Runtime & Framework:** Node.js 22 LTS, Next.js 16 (App Router Route Handlers)
- **Language:** TypeScript 5 (Strict Mode)
- **Media Engine:** `yt-dlp` (Latest upstream standalone release with auto-update at startup)
- **Audio/Video Transcoder:** `ffmpeg` & `ffprobe`
- **Distributed Queue:** BullMQ 6 + Redis (`ioredis`) with seamless in-memory fallback
- **Cloud Storage:** AWS SDK S3 v3 compatible with Cloudflare R2 ($0 egress), AWS S3, MinIO, Wasabi
- **JavaScript Challenge Solver:** Deno 2 (default) + Node.js 22 (`--js-runtimes`). Node 20 is NOT supported by yt-dlp EJS.
- **Testing & Quality:** Vitest 3, TypeScript compiler (`tsc --noEmit`)
- **Deployment:** Railway / Docker (`node:22-bookworm-slim`)

---

## Architecture

```
                  ┌─────────────────────────────────┐
                  │   Client / Frontend (Next.js)   │
                  └───────────────┬─────────────────┘
                                  │ POST /api/download
                                  ▼
                  ┌─────────────────────────────────┐
                  │    Stateless Web Server Tier     │
                  │   (Next.js App Router on Port)  │
                  └───────┬─────────────────┬───────┘
                          │                 │
    Check / Coalesce Job  │                 │ Direct Pre-signed URL
                          ▼                 │ (Cloudflare R2 / S3)
       ┌──────────────────────────────┐     │
       │       Redis 7 (BullMQ)       │     │
       │  • Queue: pullmeta-downloads │     │
       │  • Target Locks & Coalescing │     │
       │  • Job Status & Progress     │     │
       └──────────────┬───────────────┘     │
                      │                     │
           Consume    │                     │
                      ▼                     │
       ┌──────────────────────────────┐     │
       │   Dedicated Worker Pods      │     │
       │  (yt-dlp + FFmpeg + Deno)    │     │
       │  • 2–3 jobs per container    │     │
       │  • Upload to R2 / S3 Bucket  │     │
       │  • Instant Local Temp Purge  │     │
       └──────────────┬───────────────┘     │
                      │                     │
                      ▼                     ▼
       ┌────────────────────────────────────────────┐
       │   Cloudflare R2 Object Storage Bucket      │
       │   ($0 Egress Bandwidth / Global Edge CDN)  │
       └────────────────────────────────────────────┘
```

---

## Local Setup & Running

### Prerequisites
1. **Node.js** >= 18.18.0 (Node 22+ recommended)
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

# Run development server (Port 4000)
npm run dev

# (Optional) Run standalone background worker
npm run worker
```

### Running Tests & Linting
```bash
# Run unit and integration tests (Vitest)
npm test

# Run TypeScript typecheck
npm run lint
```

---

## 1,000+ Concurrent Users: Railway Deployment Guide

### Step 1: Deploy Web Service
1. Create a service in Railway connected to this repository (`pullmeta-backend`).
2. Set Build Command: `npm run build`
3. Set Start Command: `npx next start -p ${PORT:-10000} -H 0.0.0.0` (or use `Procfile`).

### Step 2: Add Redis Database
1. In your Railway project, click **+ New** -> **Database** -> **Add Redis**.
2. Railway generates the `REDIS_URL` connection string automatically.
3. In your Web Service **Variables**, click **Add Reference** to link `${{Redis.REDIS_URL}}`.

### Step 3: Deploy Worker Service
1. In the same Railway project, click **+ New** -> **GitHub Repo** -> select the same repository (`pullmeta-backend`).
2. Go to **Settings** -> **Deploy**:
   - Set **Custom Start Command** to: `npm run worker` (or point Dockerfile Path to `Dockerfile.worker`).
3. Under **Variables**:
   - Link `REDIS_URL` to `${{Redis.REDIS_URL}}`.
   - Set `WORKER_CONCURRENCY=2` (or `3` depending on RAM allocated).
   - Set your `YOUTUBE_COOKIES` if configured.
   - Set your Cloudflare R2 credentials (see below).
4. Scale this Worker Service to 2–4 replicas in Railway for seamless distributed capacity!

### Step 4: Configure Cloudflare R2 ($0 Egress Bandwidth)
Standard AWS S3 charges ~$0.09/GB for download egress. Cloudflare R2 has **$0 egress fees**.
1. In Cloudflare Dashboard, go to **R2 Object Storage** -> **Create Bucket** (e.g. `pullmeta-downloads`).
2. Go to **Manage R2 API Tokens** -> **Create API Token** (Permissions: Object Read & Write).
3. In both Web and Worker services in Railway, set:
   ```env
   S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
   S3_REGION=auto
   S3_BUCKET=pullmeta-downloads
   S3_ACCESS_KEY_ID=<your_r2_token_id>
   S3_SECRET_ACCESS_KEY=<your_r2_token_secret>
   ```

---

## Environment Variables Reference

| Variable | Mode | Default | Description |
| :--- | :--- | :--- | :--- |
| `REDIS_URL` | Distributed | *None* | Connection URL for Redis. Enables BullMQ distributed queue and request coalescing. |
| `WORKER_CONCURRENCY` | Distributed | `2` | Number of simultaneous yt-dlp download jobs processed per worker container. |
| `S3_ENDPOINT` | Distributed | *None* | S3-compatible endpoint (e.g., `https://<account>.r2.cloudflarestorage.com`). |
| `S3_BUCKET` | Distributed | *None* | Bucket name for storing completed media files. |
| `S3_ACCESS_KEY_ID` | Distributed | *None* | S3 API Access Key ID. |
| `S3_SECRET_ACCESS_KEY` | Distributed | *None* | S3 API Secret Access Key. |
| `S3_PUBLIC_DOMAIN` | Optional | *None* | Optional custom CDN domain for direct downloads (e.g., `https://downloads.pullmeta.com`). |
| `YOUTUBE_COOKIES` | Anti-Bot | *None* | YouTube authentication cookies in Netscape `cookies.txt` or JSON array format. |
| `PROXY_URL` | Anti-Bot | *None* | Optional HTTP/HTTPS/SOCKS5 proxy URL routed to yt-dlp. |
| `YT_DLP_AUTO_UPDATE` | Anti-Bot | `true` | Auto-updates yt-dlp at server startup to prevent stale extractor errors. |
| `MAX_CONCURRENT_JOBS` | Local Mode | `2` | Maximum concurrent jobs in single-instance in-memory queue. |
| `MAX_QUEUE_SIZE` | All Modes | `1000` | Maximum queue depth before rate-limiting new requests. |
| `RATE_LIMIT_DOWNLOAD_MAX` | All Modes | `20` | Max download requests permitted per IP per 15 minutes. |
| `RATE_LIMIT_EXTRACT_MAX` | All Modes | `30` | Max video metadata extract requests permitted per IP per 15 minutes. |
| `FILE_CACHE_TTL_MS` | Local Mode | `3600000` | 1 hour local disk cache retention. |

---

## Legal Disclaimer

PullMeta and PullMeta Backend are open-source software tools developed strictly for educational, archival, and fair-use purposes. Users are solely responsible for ensuring that their downloads comply with YouTube's Terms of Service, applicable copyright laws, and intellectual property rights in their jurisdiction. The developers and contributors do not host, store, or distribute copyrighted video or audio content.
