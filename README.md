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

### 3. `GET /api/health`
Health check endpoint returning `{ "ok": true }`.

## Environment Variables

- `YOUTUBE_API_KEY`: Server-only Google Cloud API key for YouTube Data API v3.
- `ALLOWED_ORIGIN`: Allowed origins for CORS (comma-separated, e.g. `https://pullmeta.vercel.app`).
- `UPSTASH_REDIS_REST_URL`: (Optional) Upstash Redis endpoint for distributed rate-limiting.
- `UPSTASH_REDIS_REST_TOKEN`: (Optional) Upstash Redis authentication token.

```bash
npm install
npm test
npm run dev # Starts on port 4000
```

## Production Deployment
Deploy with Root Directory set to `backend` on Vercel.
