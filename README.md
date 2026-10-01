# PullMeta Backend API

High-performance, standalone Next.js Route Handler service providing YouTube metadata extraction and thumbnail proxying with built-in rate limiting, multi-tier caching, and security headers.

## Endpoints

### 1. `POST /api/extract`
Extracts YouTube video metadata by video URL.

- **Request Body**:
  ```json
  {
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }
  ```
- **Success Response (200 OK)**:
  ```json
  {
    "videoId": "dQw4w9WgXcQ",
    "title": "Rick Astley - Never Gonna Give You Up",
    "description": "The official video...",
    "tags": ["rick astley", "pop"],
    "thumbnails": [
      {
        "quality": "maxres",
        "url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
        "width": 1280,
        "height": 720
      }
    ],
    "channel": "Rick Astley",
    "publishedAt": "2009-10-25T06:57:33Z",
    "duration": 213,
    "viewCount": 1800000000,
    "categoryId": "10",
    "limited": false
  }
  ```
- **Error Response (4xx/5xx)**:
  ```json
  {
    "error": {
      "code": "INVALID_URL",
      "message": "Only YouTube links are supported."
    }
  }
  ```

### 2. `GET /api/thumbnail?id=VIDEO_ID&quality=best|maxres|standard|high|medium`
Streams the thumbnail directly with `Content-Disposition: attachment; filename="VIDEO_ID-quality.jpg"`. The `best` quality parameter checks resolutions in order (`maxres -> standard -> high -> medium`) and returns the highest quality available.

### 3. `POST /api/download`
Streams the requested YouTube video with `Content-Disposition: attachment; filename="<title>.mp4"`.

- **Request Body**:
  ```json
  {
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "quality": "best"
  }
  ```
  Supported qualities: `best`, `2160p`, `1440p`, `1080p`, `720p`.
- **Success Response (200 OK)**:
  Direct binary stream (`video/mp4` or `video/webm`) using HTTP chunked transfer.
- **Error Response (4xx/5xx)**:
  Standard error payload, e.g.:
  ```json
  {
    "error": {
      "code": "DOWNLOAD_UNAVAILABLE",
      "message": "The requested quality (2160p) is not available for this video."
    }
  }
  ```
- **Error Codes**:
  - `INVALID_URL` (400): Malformed, non-YouTube, or invalid video link.
  - `DOWNLOAD_UNAVAILABLE` (404): Video is restricted or format is unavailable.
  - `DOWNLOAD_RATE_LIMITED` (429): Exceeded 5 download requests per 10 minutes or maximum concurrent limit.
  - `DOWNLOAD_TOO_LARGE` (413): Generated file exceeds server size limit (100 MB).
  - `DOWNLOAD_TIMEOUT` (504): Processing exceeded server execution window.
  - `DOWNLOAD_FAILED` (500): General extraction or processing failure.

### 4. `GET /api/health`
Health check endpoint returning `{ "ok": true }`.

## Environment Variables

- `YOUTUBE_API_KEY`: Server-only Google Cloud API key for YouTube Data API v3 (used by `/api/extract`; **not** used by `/api/download`).
- `ALLOWED_ORIGIN`: Allowed origins for CORS (comma-separated, e.g. `https://pullmeta.vercel.app`).
- `UPSTASH_REDIS_REST_URL`: (Optional) Upstash Redis endpoint for distributed rate-limiting.
- `UPSTASH_REDIS_REST_TOKEN`: (Optional) Upstash Redis authentication token.
- `YT_DLP_PATH`: (Optional) Custom path to `yt-dlp` executable. Auto-resolved from system `PATH`, `backend/bin/`, or downloaded standalone Linux binary on Vercel.
- `FFMPEG_PATH`: (Optional) Custom path to `ffmpeg` executable for merging separate DASH video and audio streams.

## Vercel Deployment & Execution Limits

- **Platform Runtime**: Node.js Serverless Function (`maxDuration = 60s` on Vercel Hobby).
- **Processing Timeout**: Internal 50-second cutoff ensures clean abort and cleanup before platform termination.
- **Max File Size**: 100 MB default ceiling to protect serverless temporary storage (`/tmp` 512 MB limit) and bandwidth.
- **Rate Limit**: 5 downloads per IP per 10 minutes, with in-memory concurrent processing limit.
- **Large Functions**: If deploying custom bundled binaries exceeds standard sizes, Vercel Fluid Compute Large Functions can be enabled via `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`.

```bash
npm install
npm test
npm run dev # Starts on port 4000
```

## Production Deployment

- **Railway (Recommended for persistent downloads & Docker)**:
  - Root directory: `/backend`
  - Builder: Uses `Dockerfile` automatically (configured via `railway.json`).
  - Required Variables: `ALLOWED_ORIGIN`, `YOUTUBE_API_KEY`.
  - Health check path: `/api/health`.
- **Vercel (Serverless)**:
  - Deploy with Root Directory set to `backend`.

