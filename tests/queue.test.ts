import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isBullMQEnabled, getJobQueue, jobQueue } from "@/lib/jobs";

describe("Queue Resolution & Driver Selection", () => {
  const origRedis = process.env.REDIS_URL;
  const origDriver = process.env.QUEUE_DRIVER;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_PRIVATE_URL;
    delete process.env.QUEUE_DRIVER;
  });

  afterEach(() => {
    if (origRedis) process.env.REDIS_URL = origRedis;
    if (origDriver) process.env.QUEUE_DRIVER = origDriver;
  });

  it("defaults to in-memory queue when REDIS_URL is not set", () => {
    expect(isBullMQEnabled()).toBe(false);
    expect(jobQueue.driver).toBe("in-memory");
  });

  it("respects QUEUE_DRIVER='in-memory' even if REDIS_URL is configured", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.QUEUE_DRIVER = "in-memory";

    expect(isBullMQEnabled()).toBe(false);
  });
});
