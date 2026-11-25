'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gm = require('./game-math');

test('crashPointFromSeed & decideCrash deterministic bounds and cashout/crash rules', () => {
  const cp = gm.crashPointFromSeed('seed-abc', 'round-1', 0.96, 100);
  assert.ok(cp >= 1.0 && cp <= 100, `crashPoint out of bounds: ${cp}`);

  // Same seed + roundId produces deterministic crash point
  assert.equal(cp, gm.crashPointFromSeed('seed-abc', 'round-1', 0.96, 100));

  // Early manual cashout below 1.01 returns EARLY
  assert.deepEqual(gm.decideCrash({ cp: 5, auto: 0, el: 0.05, cashout: true, clientMult: 1.00 }), { state: 'EARLY' });

  // Valid manual cashout below cp succeeds
  const won = gm.decideCrash({ cp: 5.0, auto: 0, el: 10, cashout: true, clientMult: 1.4 });
  assert.equal(won.state, 'WON');
  assert.ok(won.mult >= 1.01 && won.mult <= 1.4);

  // Auto cashout triggers when server growth reaches auto < cp
  const autoWon = gm.decideCrash({ cp: 10.0, auto: 1.5, el: 20, cashout: false, clientMult: 0 });
  assert.deepEqual(autoWon, { state: 'WON', mult: 1.5 });

  // Crashes when delayed growth reaches cp
  const crashed = gm.decideCrash({ cp: 1.1, auto: 0, el: 30, cashout: false, clientMult: 0 });
  assert.deepEqual(crashed, { state: 'CRASHED' });
});

test('KenoFast & ClassicKeno return matching paytable & valid shared 20-number draws', () => {
  assert.deepEqual(gm.kenoTable(2, 0.92), [0, 1, 10]);
  assert.deepEqual(gm.kenoTable(3, 0.92), [0, 0, 2, 50]);
  assert.deepEqual(gm.kenoTable(4, 0.92), [0, 0, 1.5, 10, 80]);
  assert.deepEqual(gm.kenoTable(6, 0.92), [0, 0, 0, 2, 15, 60, 500]);
  assert.deepEqual(gm.kenoTable(10, 0.92), [2, 0, 0, 0, 0, 5, 30, 100, 300, 2000, 10000]);

  for (const game of ['KenoFast', 'ClassicKeno']) {
    const tbl = gm.kenoTable(5, 0.92);
    assert.equal(tbl.length, 6);
    assert.ok(tbl.some(m => m > 0));

    const opts = { kenoSecret: 'test-secret-keno' };
    const r1 = gm.resolveInstant(game, 50, { picks: [3, 12, 25, 44, 79], roundId: 893718123 }, 0.92, 25000, opts);
    const r2 = gm.resolveInstant(game, 50, { picks: [1, 2, 3], roundId: 893718123 }, 0.92, 25000, opts);
    assert.equal(r1.visual.drawnNumbers.length, 20);
    assert.equal(new Set(r1.visual.drawnNumbers).size, 20);
    assert.deepEqual(r1.visual.drawnNumbers, r2.visual.drawnNumbers);
    assert.ok(r1.payout >= 0);
  }
  assert.throws(() => gm.resolveInstant('ClassicKeno', 50, { picks: [1, 1] }, 0.92, 25000), gm.Bad);
  assert.throws(() => gm.resolveInstant('KenoFast', 50, { picks: [81] }, 0.92, 25000), gm.Bad);
});

test('Slot777 produces 3 valid reel symbols, 1x..5x colMult, payline, and non-negative payout', () => {
  const seenMults = new Set();
  for (let i = 0; i < 120; i++) {
    const res = gm.resolveInstant('Slot777', 25, {}, 0.94, 25000);
    assert.equal(res.visual.reels.length, 3);
    for (const sym of res.visual.reels) {
      assert.ok(gm.SLOT.ids.includes(sym));
    }
    assert.ok([1, 2, 3, 4, 5].includes(res.visual.colMult));
    assert.ok(res.visual.winType === 'NONE' ? res.visual.payline === 'NONE' : gm.SLOT_PAYLINES.includes(res.visual.payline));
    seenMults.add(res.visual.colMult);
    assert.ok(res.payout >= 0);
  }
  assert.ok(seenMults.size >= 3, `Expected varied multipliers in 1x..5x, saw ${[...seenMults]}`);
});

test('PlinkoX validates risk, ballCount, and per-ball minimum wager', () => {
  const res = gm.resolveInstant('PlinkoX', 50, { risk: 'medium', ballCount: 5 }, 0.94, 25000);
  assert.equal(res.visual.rows, 16);
  assert.equal(res.visual.balls.length, 5);
  assert.equal(res.visual.unitBet, 10);
  assert.ok(res.payout >= 0);

  assert.throws(() => gm.resolveInstant('PlinkoX', 50, { risk: 'ultra', ballCount: 5 }, 0.94, 25000), gm.Bad);
  assert.throws(() => gm.resolveInstant('PlinkoX', 5, { risk: 'low', ballCount: 10 }, 0.94, 25000), gm.Bad);
});

test('Roulette validates table sum, maxPayout guard, and produces 0..36', () => {
  const res = gm.resolveInstant('Roulette', 30, {
    bets: [
      { type: 'red', amount: 20 },
      { type: 'num-17', amount: 10 }
    ]
  }, 0.94, 25000);
  assert.ok(res.visual.winningNumber >= 0 && res.visual.winningNumber <= 36);
  assert.ok(['red', 'black', 'green'].includes(res.visual.color));

  // Mismatched wager vs sum throws Bad
  assert.throws(() => gm.resolveInstant('Roulette', 50, { bets: [{ type: 'red', amount: 20 }] }, 0.94, 25000), gm.Bad);
  // Straight-up exceeding maxPayout throws Bad
  assert.throws(() => gm.resolveInstant('Roulette', 1000, { bets: [{ type: 'num-7', amount: 1000 }] }, 0.94, 25000), gm.Bad);
});

test('AviaMasters returns valid landing state and 6 trajectory items', () => {
  const res = gm.resolveInstant('AviaMasters', 40, {}, 0.94, 25000);
  assert.equal(typeof res.visual.landed, 'boolean');
  assert.equal(res.visual.items.length, 6);
  assert.ok(res.payout >= 0);
});

test('LuckyChicken survival probabilities decrease monotonically and stay <= 1', () => {
  for (const diff of ['easy', 'medium', 'hard', 'hardcore']) {
    const probs = gm.chickenSurvival(diff, 0.94);
    assert.equal(probs.length, 5);
    for (let i = 0; i < probs.length; i++) {
      assert.ok(probs[i] > 0 && probs[i] <= 1);
      if (i > 0) assert.ok(probs[i] <= probs[i - 1]);
    }
  }
});

test('ChickenRoad2, RoastedChicken, and MegaBlock survival curves and visualOutcomes work for all difficulties', () => {
  for (const [game, diffs] of [
    ['ChickenRoad2', ['Easy', 'Medium', 'Hard', 'Hardcore']],
    ['RoastedChicken', ['Easy', 'Medium', 'Hard', 'Extreme']]
  ]) {
    for (const d of diffs) {
      const mults = gm.CHICKEN_INSTANT[game][d];
      const curve = gm.survivalCurve(mults, 0.94);
      assert.equal(curve.length, mults.length);
      for (let i = 0; i < curve.length; i++) {
        assert.ok(curve[i] > 0 && curve[i] <= 1);
        if (i > 0) assert.ok(curve[i] <= curve[i - 1]);
      }
    }
  }

  const cr = gm.resolveInstant('ChickenRoad2', 20, { difficulty: 'Medium' }, 0.94, 25000);
  assert.equal(typeof cr.visual.maxSafeStep, 'number');
  assert.equal(cr.visual.difficulty, 'Medium');
  assert.ok(cr.payout >= 0 && cr.payout <= 25000);

  const rc = gm.resolveInstant('RoastedChicken', 20, { difficulty: 'Extreme' }, 0.94, 25000);
  assert.equal(typeof rc.visual.maxSafeStep, 'number');
  assert.equal(rc.visual.difficulty, 'Extreme');
  assert.ok(rc.payout >= 0 && rc.payout <= 25000);

  const mb = gm.resolveInstant('MegaBlock', 25, { difficulty: 'HARD' }, 0.94, 25000);
  assert.equal(typeof mb.visual.maxSafeBlocks, 'number');
  assert.equal(mb.visual.difficulty, 'HARD');
  assert.ok(mb.payout >= 0 && mb.payout <= 25000);

  assert.throws(() => gm.resolveInstant('UnknownGame', 10, {}, 0.94, 25000), gm.Bad);
});

test('addisParts & cashbackDue follow EAT 10:00 AM daily trigger', () => {
  // 2026-03-01 07:30 UTC is 10:30 EAT (hour 10)
  const dt = new Date('2026-03-01T07:30:00.000Z');
  const p = gm.addisParts(dt);
  assert.equal(p.date, '2026-03-01');
  assert.equal(p.hour, 10);
  assert.equal(gm.cashbackDue(dt, '2026-02-28', 10), '2026-03-01');
  assert.equal(gm.cashbackDue(dt, '2026-03-01', 10), null);
});
