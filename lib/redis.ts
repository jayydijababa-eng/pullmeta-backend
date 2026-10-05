import Redis, { RedisOptions } from "ioredis";

export function getRedisUrl(): string | undefined {
  return (
    process.env.REDIS_URL ||
    process.env.REDIS_PRIVATE_URL ||
    process.env.KV_URL
  );
}

export function isRedisConfigured(): boolean {
  return Boolean(getRedisUrl());
}

export function createRedisClient(customOptions?: Partial<RedisOptions>): Redis {
  const url = getRedisUrl();
  if (!url) {
    throw new Error("REDIS_URL is not configured.");
  }

  const isTls = url.startsWith("rediss://");

  const options: RedisOptions = {
    maxRetriesPerRequest: null, // Critical requirement for BullMQ
    enableReadyCheck: false,
    retryStrategy(times) {
      const delay = Math.min(times * 150, 3000);
      return delay;
    },
    tls: isTls ? { rejectUnauthorized: false } : undefined,
    ...customOptions,
  };

  const client = new Redis(url, options);

  client.on("error", (err) => {
    console.error("[Redis Client Error]", err?.message || err);
  });

  return client;
}

let sharedRedisClient: Redis | null = null;

export function getSharedRedisClient(): Redis {
  if (!sharedRedisClient) {
    sharedRedisClient = createRedisClient();
  }
  return sharedRedisClient;
}
