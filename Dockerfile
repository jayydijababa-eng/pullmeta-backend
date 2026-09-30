# PullMeta Backend - Dockerfile for Render, Hugging Face Spaces & Container Hosting
# Includes Node.js 20, Python 3, FFmpeg, and yt-dlp

FROM node:20-bookworm-slim

# Install system dependencies: ffmpeg, python3, curl, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

# The official node:20 image already provides the user 'node' with UID 1000
USER node
ENV HOME=/home/node \
    PATH=/home/node/.local/bin:$PATH \
    NODE_ENV=production \
    PORT=10000 \
    HOSTNAME=0.0.0.0 \
    MAX_FILE_SIZE_BYTES=5368709120 \
    DOWNLOAD_TIMEOUT_MS=600000 \
    MAX_CONCURRENT_DOWNLOADS=5

WORKDIR /home/node/app

# Copy dependency manifests
COPY --chown=node:node package*.json ./

# Install production dependencies
RUN npm ci || npm install

# Copy application source code
COPY --chown=node:node . .

# Build Next.js application
RUN npm run build

# Expose standard ports (Render defaults to 10000, Hugging Face to 7860)
EXPOSE 10000 7860

# Start Next.js server on the configured $PORT
CMD ["sh", "-c", "npx next start -p ${PORT:-10000} -H 0.0.0.0"]
