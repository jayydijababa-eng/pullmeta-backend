let hasLoggedMissingKeyWarning = false;

export interface AppConfig {
  youtubeApiKey: string | null;
  allowedOrigins: string[];
  upstashRedisUrl?: string;
  upstashRedisToken?: string;
}

export function getConfig(): AppConfig {
  const key = process.env.YOUTUBE_API_KEY?.trim() || null;

  if (!key && !hasLoggedMissingKeyWarning) {
    hasLoggedMissingKeyWarning = true;
    console.warn(
      "[PullMeta Backend Warning] YOUTUBE_API_KEY is not configured. Falling back to free oEmbed endpoint with limited metadata."
    );
  }

  const origins = (process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    youtubeApiKey: key,
    allowedOrigins: origins,
    upstashRedisUrl: process.env.UPSTASH_REDIS_REST_URL?.trim() || undefined,
    upstashRedisToken: process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || undefined,
  };
}
