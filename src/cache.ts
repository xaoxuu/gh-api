import { getCache } from '@vercel/functions';

export interface Cache {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown, ttl: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export class RuntimeCache implements Cache {
  async get<T>(key: string): Promise<T | null> { return await getCache().get(key) as T | null; }
  async set(key: string, value: unknown, ttl: number) { await getCache().set(key, value, { ttl }); }
  async delete(key: string) { await getCache().delete(key); }
}

/** Bounded local fallback; never a substitute for shared state on Vercel. */
export class MemoryCache implements Cache {
  private values = new Map<string, { value: unknown; expires: number; bytes: number }>();
  private bytes = 0;
  constructor(private now = Date.now, private maxBytes = 16 * 1024 * 1024) {}
  async get<T>(key: string): Promise<T | undefined> {
    const item = this.values.get(key);
    if (!item) return;
    if (item.expires <= this.now()) { await this.delete(key); return; }
    this.values.delete(key); this.values.set(key, item);
    return item.value as T;
  }
  async set(key: string, value: unknown, ttl: number) {
    await this.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) return;
    while (this.values.size >= 256 || this.bytes + bytes > this.maxBytes) await this.delete(this.values.keys().next().value!);
    this.values.set(key, { value, expires: this.now() + ttl * 1000, bytes });
    this.bytes += bytes;
  }
  async delete(key: string) {
    this.bytes -= this.values.get(key)?.bytes ?? 0;
    this.values.delete(key);
  }
}
