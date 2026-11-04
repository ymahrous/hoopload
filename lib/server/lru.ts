/**
 * Tiny TTL + LRU cache. Used to keep hot upload sessions in process memory so
 * chunk PUTs never touch the database (the largest saving on Neon's free tier).
 */
export class TtlLru<K, V> {
  private map = new Map<K, { value: V; expires: number }>();

  constructor(
    private max: number,
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V, ttlMs = this.ttlMs): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
