'use strict';

/**
 * Bounded TTL cache with single-flight promise coalescing so concurrent requests
 * for the same key share one database/upstream call.
 */
function createTtlCache({ maxEntries = 200 } = {}) {
  const store = new Map();
  const inflight = new Map();

  function pruneIfNeeded() {
    if (store.size <= maxEntries) return;
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt <= now) store.delete(k);
    }
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
  }

  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value, ttlMs) {
    if (!(ttlMs > 0)) return value;
    if (store.has(key)) store.delete(key);
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    pruneIfNeeded();
    return value;
  }

  async function getOrLoad(key, ttlMs, loader) {
    const hit = get(key);
    if (hit !== undefined) return hit;

    const pending = inflight.get(key);
    if (pending) return pending;

    const p = Promise.resolve()
      .then(() => loader())
      .then(val => {
        set(key, val, ttlMs);
        return val;
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, p);
    return p;
  }

  function invalidate(prefixOrKey) {
    if (!prefixOrKey) {
      store.clear();
      return;
    }
    for (const k of [...store.keys()]) {
      if (k === prefixOrKey || k.startsWith(prefixOrKey)) {
        store.delete(k);
      }
    }
  }

  return { get, set, getOrLoad, invalidate, size: () => store.size };
}

/**
 * Memory-bounded fixed-window rate limiter (O(1) per check, no per-hit array allocations).
 */
function createRateTracker({ maxKeys = 10000 } = {}) {
  const buckets = new Map();

  function hit(key, max, windowMs, now = Date.now()) {
    let b = buckets.get(key);
    if (!b || now - b.start >= windowMs) {
      if (!b && buckets.size >= maxKeys) {
        cleanup(now);
        if (buckets.size >= maxKeys) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
      }
      b = { start: now, count: 1, ttl: windowMs };
      buckets.set(key, b);
      return { allowed: true, count: 1 };
    }
    b.count += 1;
    b.ttl = Math.max(b.ttl, windowMs);
    return { allowed: b.count <= max, count: b.count };
  }

  function cleanup(now = Date.now()) {
    for (const [k, b] of buckets) {
      if (now - b.start >= Math.max(b.ttl || 60000, 3600000)) {
        buckets.delete(k);
      }
    }
  }

  return { hit, cleanup, size: () => buckets.size };
}

/**
 * Fixed-capacity chat message ring buffer hydrated once from DB on startup.
 */
function createChatBuffer(maxSize = 30) {
  let items = [];
  let hydrated = false;

  function seed(messages) {
    items = Array.isArray(messages) ? messages.slice(-maxSize) : [];
    hydrated = true;
  }

  function push(msg) {
    items.push(msg);
    if (items.length > maxSize) {
      items = items.slice(items.length - maxSize);
    }
  }

  function list() {
    return items.slice();
  }

  return {
    seed,
    push,
    list,
    isHydrated: () => hydrated
  };
}

module.exports = {
  createTtlCache,
  createRateTracker,
  createChatBuffer
};
