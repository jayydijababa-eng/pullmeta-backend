import { Redis } from "@upstash/redis";
export { getClientIp, isValidIp, cleanIp, isPrivateOrInternalIp } from "./ip";

export type RateLimitAction = "extract" | "thumbnail" | "download";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

const LIMITS: Record<RateLimitAction, { max: number; windowMs: number }> = {
  extract: {
    max: process.env.RATE_LIMIT_EXTRACT_MAX
      ? parseInt(process.env.RATE_LIMIT_EXTRACT_MAX, 10)
      : 30,
    windowMs: process.env.RATE_LIMIT_EXTRACT_WINDOW_MS
      ? parseInt(process.env.RATE_LIMIT_EXTRACT_WINDOW_MS, 10)
      : 15 * 60 * 1000, // 30 per 15 min
  },
  thumbnail: {
    max: 100,
    windowMs: 15 * 60 * 1000,
  },
  download: {
    max: process.env.RATE_LIMIT_DOWNLOAD_MAX
      ? parseInt(process.env.RATE_LIMIT_DOWNLOAD_MAX, 10)
      : 20,
    windowMs: process.env.RATE_LIMIT_DOWNLOAD_WINDOW_MS
      ? parseInt(process.env.RATE_LIMIT_DOWNLOAD_WINDOW_MS, 10)
      : 15 * 60 * 1000, // 20 per 15 min default (configurable)
  },
};

// In-memory sliding log storage
const inMemoryStore = new Map<string, number[]>();

export function resetRateLimitStore(): void {
  inMemoryStore.clear();
}

// Lazily initialize Upstash Redis if env vars provided
let redisClient: Redis | null = null;
function getRedis(): Redis | null {
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      redisClient = new Redis({ url, token });
      return redisClient;
    } catch {
      return null;
    }
  }
  return null;
}

export async function checkRateLimit(
  ip: string,
  action: RateLimitAction
): Promise<RateLimitResult> {
  const { max, windowMs } = LIMITS[action];
  const redis = getRedis();

  if (redis) {
    try {
      const key = `ratelimit:${action}:${ip}`;
      const now = Date.now();
      const clearBefore = now - windowMs;

      // Sliding window using sorted sets
      const pipeline = redis.pipeline();
      pipeline.zremrangebyscore(key, 0, clearBefore);
      pipeline.zadd(key, { score: now, member: `${now}-${Math.random()}` });
      pipeline.zcard(key);
      pipeline.pexpire(key, windowMs);

      const results = await pipeline.exec();
      const count = Number(results[2] || 0);

      const remaining = Math.max(0, max - count);
      const allowed = count <= max;

      return {
        allowed,
        remaining,
        resetInMs: windowMs,
      };
    } catch {
      // Fallback to in-memory if Redis temporarily fails
    }
  }

  // In-memory rate limiting
  const key = `${action}:${ip}`;
  const now = Date.now();
  const timestamps = inMemoryStore.get(key) || [];

  const validTimestamps = timestamps.filter((t) => now - t < windowMs);

  if (validTimestamps.length >= max) {
    const oldest = validTimestamps[0];
    const resetInMs = Math.max(0, windowMs - (now - oldest));
    return {
      allowed: false,
      remaining: 0,
      resetInMs,
    };
  }

  validTimestamps.push(now);
  inMemoryStore.set(key, validTimestamps);

  // Clean old keys occasionally
  if (inMemoryStore.size > 2000) {
    for (const [k, ts] of inMemoryStore.entries()) {
      if (ts.every((t) => now - t >= windowMs)) {
        inMemoryStore.delete(k);
      }
    }
  }

  return {
    allowed: true,
    remaining: max - validTimestamps.length,
    resetInMs: windowMs,
  };
}
