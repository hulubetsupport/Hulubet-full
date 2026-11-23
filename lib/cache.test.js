'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTtlCache, createRateTracker, createChatBuffer } = require('./cache');

test('createTtlCache coalesces concurrent misses and respects TTL & invalidation', async () => {
  const cache = createTtlCache({ maxEntries: 3 });
  let loads = 0;

  const loader = async () => {
    loads += 1;
    await new Promise(r => setTimeout(r, 20));
    return { ok: true, loads };
  };

  // 5 concurrent callers share 1 upstream call
  const results = await Promise.all([
    cache.getOrLoad('feed:JetX', 200, loader),
    cache.getOrLoad('feed:JetX', 200, loader),
    cache.getOrLoad('feed:JetX', 200, loader),
    cache.getOrLoad('feed:JetX', 200, loader),
    cache.getOrLoad('feed:JetX', 200, loader)
  ]);

  assert.equal(loads, 1);
  assert.equal(results[0].loads, 1);
  assert.equal(results[4].loads, 1);

  // Prefix invalidation clears feed:*
  cache.invalidate('feed:');
  const next = await cache.getOrLoad('feed:JetX', 200, loader);
  assert.equal(loads, 2);
  assert.equal(next.loads, 2);

  // Bounded capacity
  cache.set('k1', 1, 1000);
  cache.set('k2', 2, 1000);
  cache.set('k3', 3, 1000);
  cache.set('k4', 4, 1000);
  assert.equal(cache.size(), 3);
});

test('createRateTracker enforces window limit with bounded memory', () => {
  const rt = createRateTracker({ maxKeys: 2 });
  const t0 = 1000000;

  assert.equal(rt.hit('u1', 2, 1000, t0).allowed, true);
  assert.equal(rt.hit('u1', 2, 1000, t0 + 10).allowed, true);
  assert.equal(rt.hit('u1', 2, 1000, t0 + 20).allowed, false);

  // Window reset allows requests again
  assert.equal(rt.hit('u1', 2, 1000, t0 + 1005).allowed, true);

  // Max keys bound holds
  rt.hit('u2', 2, 1000, t0 + 1010);
  rt.hit('u3', 2, 1000, t0 + 1020);
  assert.equal(rt.size(), 2);
});

test('createChatBuffer maintains bounded latest messages', () => {
  const buf = createChatBuffer(3);
  assert.equal(buf.isHydrated(), false);
  buf.seed([{ id: 1 }, { id: 2 }]);
  assert.equal(buf.isHydrated(), true);
  buf.push({ id: 3 });
  buf.push({ id: 4 });
  assert.deepEqual(buf.list().map(m => m.id), [2, 3, 4]);
});
