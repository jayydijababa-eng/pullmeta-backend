# PullMeta Backend - Dockerfile for Hugging Face Spaces & Container Hosting
# Includes Node.js 20, Python 3, FFmpeg, and yt-dlp

FROM node:20-bookworm-slim

# Install system dependencies: ffmpeg, python3, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces requires non-root user with UID 1000
RUN useradd -m -u 1000 user

USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    NODE_ENV=production \
    PORT=7860 \
    HOSTNAME=0.0.0.0 \
    MAX_FILE_SIZE_BYTES=5368709120 \
    DOWNLOAD_TIMEOUT_MS=600000 \
    MAX_CONCURRENT_DOWNLOADS=5

WORKDIR $HOME/app

# Copy dependency manifests
COPY --chown=user:user package*.json ./

# Install production dependencies
RUN npm ci || npm install

# Copy application source code
COPY --chown=user:user . .

# Build Next.js application
RUN npm run build

# Expose standard Hugging Face Spaces port
EXPOSE 7860

# Start Next.js server
CMD ["npx", "next", "start", "-p", "7860", "-H", "0.0.0.0"]
