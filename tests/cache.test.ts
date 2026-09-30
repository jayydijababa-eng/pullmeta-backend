import { describe, it, expect, beforeEach } from "vitest";
import { cache } from "../lib/cache";

describe("In-Memory LRU Cache", () => {
  beforeEach(() => {
    cache.clear();
  });

  it("stores and retrieves values correctly", () => {
    cache.set("key1", { title: "Test Video" });
    const val = cache.get<{ title: string }>("key1");
    expect(val).toEqual({ title: "Test Video" });
  });

  it("returns null for non-existent keys", () => {
    expect(cache.get("missing")).toBeNull();
  });

  it("expires keys after TTL", async () => {
    // 50ms TTL
    cache.set("short_key", "temporary", 50);
    expect(cache.get("short_key")).toBe("temporary");

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cache.get("short_key")).toBeNull();
  });

  it("evicts oldest entries when reaching capacity limit", () => {
    // Fill beyond limit
    for (let i = 0; i < 505; i++) {
      cache.set(`entry_${i}`, i);
    }
    expect(cache.size()).toBeLessThanOrEqual(500);
    // Oldest key entry_0 should have been evicted
    expect(cache.get("entry_0")).toBeNull();
    // Newest key entry_504 must still exist
    expect(cache.get("entry_504")).toBe(504);
  });
});
