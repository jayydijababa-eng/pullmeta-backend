interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ENTRIES = 500;

class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    // Refresh position for LRU
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= MAX_ENTRIES) {
      // Evict expired first, or oldest insertion
      let evicted = false;
      const now = Date.now();
      for (const [k, v] of this.store.entries()) {
        if (now > v.expiresAt) {
          this.store.delete(k);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        // Evict oldest (first key in map iterator)
        const oldestKey = this.store.keys().next().value;
        if (oldestKey) {
          this.store.delete(oldestKey);
        }
      }
    }

    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

export const cache = new MemoryCache();
