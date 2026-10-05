# PullMeta Backend - Dockerfile for Railway, Render, Hugging Face Spaces & Container Hosting
# Includes Node.js 22, Deno, Python 3, FFmpeg, and yt-dlp
#
# Why Node 22 + Deno: yt-dlp must solve YouTube's JavaScript challenges with an external
# JS runtime (EJS). Supported runtimes are Deno >= 2.3 (recommended) or Node >= 22.
# Node 20 is NOT supported -> challenges go unsolved -> "HTTP Error 403: Forbidden".

# Official Deno binary (used only as a copy source)
FROM denoland/deno:bin AS deno

FROM node:22-bookworm-slim

# Install system dependencies: ffmpeg, python3 (yt-dlp zipimport binary), curl, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Deno JS runtime for yt-dlp EJS challenge solving
COPY --from=deno /deno /usr/local/bin/deno
RUN deno --version

# The official node image already provides the user 'node' with UID 1000
USER node
ENV HOME=/home/node \
    PATH=/home/node/bin:/home/node/.local/bin:$PATH \
    YT_DLP_PATH=/home/node/bin/yt-dlp \
    DENO_DIR=/home/node/.cache/deno \
    PORT=10000 \
    HOSTNAME=0.0.0.0 \
    MAX_FILE_SIZE_BYTES=5368709120 \
    DOWNLOAD_TIMEOUT_MS=600000 \
    MAX_CONCURRENT_DOWNLOADS=3

# Install latest yt-dlp into a user-owned folder so the server can self-update it at startup
# (YouTube changes frequently; a stale yt-dlp is the #1 cause of download failures).
# Bump YTDLP_CACHE_BUST to force a fresh download on rebuild.
ARG YTDLP_CACHE_BUST=2026-10-05
RUN mkdir -p /home/node/bin \
 && curl -sSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /home/node/bin/yt-dlp \
 && chmod a+rx /home/node/bin/yt-dlp \
 && /home/node/bin/yt-dlp --version

WORKDIR /home/node/app

# Copy dependency manifests
COPY --chown=node:node package*.json ./

# Install all dependencies including TypeScript and type declarations needed for build
RUN npm ci --include=dev || npm install --include=dev

# Copy application source code
COPY --chown=node:node . .

# Build Next.js application
RUN npm run build

# Set production environment for runtime
ENV NODE_ENV=production

# Expose standard ports (Render defaults to 10000, Hugging Face to 7860)
EXPOSE 10000 7860

# Start Next.js server on the configured $PORT
CMD ["sh", "-c", "npx next start -p ${PORT:-10000} -H 0.0.0.0"]
