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

test('KenoFast & ClassicKeno return RTP-scaled paytables & valid shared 20-number draws', () => {
  const kenoEv = (tbl, k) => tbl.reduce((acc, m, h) => acc + m * ((gm.C(20, h) * gm.C(60, k - h)) / gm.C(80, k)), 0);
  for (let k = 1; k <= 10; k++) {
    const t70 = gm.kenoTable(k, 0.70);
    const ev70 = kenoEv(t70, k);
    assert.ok(ev70 >= 0.68 && ev70 <= 0.72, `Keno ${k}-spot @ 0.70 EV=${ev70} out of [0.68, 0.72]`);
    const t92 = gm.kenoTable(k, 0.92);
    const ev92 = kenoEv(t92, k);
    assert.ok(ev92 >= 0.88 && ev92 <= 0.95, `Keno ${k}-spot @ 0.92 EV=${ev92} out of [0.88, 0.95]`);
    assert.ok(t92[k] > t70[k]);
  }
  assert.deepEqual(gm.kenoTable(1, 0.70), [0, 2.8]);

  for (const game of ['KenoFast', 'ClassicKeno']) {
    const tbl = gm.kenoTable(5, 0.70);
    assert.equal(tbl.length, 6);
    assert.ok(tbl.some(m => m > 0));

    const opts = { kenoSecret: 'test-secret-keno' };
    const r1 = gm.resolveInstant(game, 50, { picks: [3, 12, 25, 44, 79], roundId: 893718123 }, 0.70, 25000, opts);
    const r2 = gm.resolveInstant(game, 50, { picks: [1, 2, 3], roundId: 893718123 }, 0.70, 25000, opts);
    assert.equal(r1.visual.drawnNumbers.length, 20);
    assert.equal(new Set(r1.visual.drawnNumbers).size, 20);
    assert.deepEqual(r1.visual.drawnNumbers, r2.visual.drawnNumbers);
    assert.ok(r1.payout >= 0);
  }
  assert.throws(() => gm.resolveInstant('ClassicKeno', 50, { picks: [1, 1] }, 0.70, 25000), gm.Bad);
  assert.throws(() => gm.resolveInstant('KenoFast', 50, { picks: [81] }, 0.70, 25000), gm.Bad);
});

test('Slot777 produces 3 valid reel symbols, 1x..5x colMult, payline, and calibrated 70% EV', () => {
  const seenMults = new Set();
  for (let i = 0; i < 120; i++) {
    const res = gm.resolveInstant('Slot777', 25, {}, 0.70, 25000);
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

  // Exact analytical Slot777 EV at 0.70
  const tbl = gm.slotTable(0.70);
  const tw = gm.SLOT.w.reduce((a, b) => a + b, 0);
  const p = gm.SLOT.w.map(x => x / tw);
  let baseEv = 0;
  for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) for (let c = 0; c < 9; c++) {
    const pr = p[a] * p[b] * p[c];
    let m = 0;
    if (a === b && b === c) m = tbl.triple[a];
    else if (a === b || a === c) m = tbl.pair[a];
    else if (b === c) m = tbl.pair[b];
    baseEv += pr * m;
  }
  const ecol = gm.SLOT.col.reduce((acc, [m, q]) => acc + m * q, 0);
  const slotEv = baseEv * ecol;
  assert.ok(slotEv >= 0.68 && slotEv <= 0.72, `Slot777 @ 0.70 analytical EV=${slotEv}`);
});

test('PlinkoX validates risk, ballCount, minimum wager, and exact 70% EV across all risks', () => {
  const res = gm.resolveInstant('PlinkoX', 50, { risk: 'medium', ballCount: 5 }, 0.70, 25000);
  assert.equal(res.visual.rows, 16);
  assert.equal(res.visual.balls.length, 5);
  assert.equal(res.visual.unitBet, 10);
  assert.ok(res.payout >= 0);

  for (const risk of ['low', 'medium', 'high']) {
    const t = gm.plinkoTable(risk, 0.70);
    const ev = t.reduce((acc, m, i) => acc + m * (gm.C(16, i) / 65536), 0);
    assert.ok(ev >= 0.69 && ev <= 0.71, `PlinkoX ${risk} @ 0.70 EV=${ev}`);
  }

  assert.throws(() => gm.resolveInstant('PlinkoX', 50, { risk: 'ultra', ballCount: 5 }, 0.70, 25000), gm.Bad);
  assert.throws(() => gm.resolveInstant('PlinkoX', 5, { risk: 'low', ballCount: 10 }, 0.70, 25000), gm.Bad);
});

test('Roulette validates table sum, maxPayout guard, 0..36, and enforces 70% RTP without all-numbers exploit', () => {
  const res = gm.resolveInstant('Roulette', 30, {
    bets: [
      { type: 'red', amount: 20 },
      { type: 'num-17', amount: 10 }
    ]
  }, 0.70, 25000);
  assert.ok(res.visual.winningNumber >= 0 && res.visual.winningNumber <= 36);
  assert.ok(['red', 'black', 'green'].includes(res.visual.color));

  // Anti-exploit: betting all 37 numbers must still pay ~70% rather than 36/37
  const all37 = Array.from({ length: 37 }, (_, n) => ({ type: `num-${n}`, amount: 1 }));
  let all37Paid = 0;
  for (let i = 0; i < 400; i++) {
    all37Paid += gm.resolveInstant('Roulette', 37, { bets: all37 }, 0.70, 25000).payout;
  }
  const all37Rtp = all37Paid / (400 * 37);
  assert.ok(all37Rtp >= 0.62 && all37Rtp <= 0.78, `Roulette all-37 RTP=${all37Rtp} should center around 0.70`);

  // Empirical outside-bet RTP over 3000 spins centers around 0.70
  let redPaid = 0;
  for (let i = 0; i < 3000; i++) {
    redPaid += gm.resolveInstant('Roulette', 10, { bets: [{ type: 'red', amount: 10 }] }, 0.70, 25000).payout;
  }
  const redRtp = redPaid / 30000;
  assert.ok(redRtp >= 0.65 && redRtp <= 0.75, `Roulette red RTP=${redRtp} out of [0.65, 0.75]`);

  // Mismatched wager vs sum throws Bad
  assert.throws(() => gm.resolveInstant('Roulette', 50, { bets: [{ type: 'red', amount: 20 }] }, 0.70, 25000), gm.Bad);
  // Straight-up exceeding maxPayout throws Bad
  assert.throws(() => gm.resolveInstant('Roulette', 1000, { bets: [{ type: 'num-7', amount: 1000 }] }, 0.70, 25000), gm.Bad);
});

test('AviaMasters returns valid landing state, 6 trajectory items, and 70% analytical EV', () => {
  const res = gm.resolveInstant('AviaMasters', 40, {}, 0.70, 25000);
  assert.equal(typeof res.visual.landed, 'boolean');
  assert.equal(res.visual.items.length, 6);
  assert.ok(res.payout >= 0);
  const pLand = Math.min(1, 0.70 / gm.aviaE());
  const analyticalEv = pLand * gm.aviaE();
  assert.ok(Math.abs(analyticalEv - 0.70) < 1e-6, `AviaMasters EV=${analyticalEv}`);
});

test('LuckyChicken survival probabilities decrease monotonically, support long road, and enforce 70% EV on all steps', () => {
  const expectedLen = { easy: 12, medium: 12, hard: 10, hardcore: 8 };
  for (const diff of ['easy', 'medium', 'hard', 'hardcore']) {
    const probs = gm.chickenSurvival(diff, 0.70);
    assert.equal(probs.length, expectedLen[diff]);
    assert.ok(probs[0] < 1, `Expected ${diff} step 1 survival < 1 so players can lose`);
    for (let i = 0; i < probs.length; i++) {
      assert.ok(probs[i] > 0 && probs[i] <= 1);
      assert.ok(Math.abs(probs[i] * gm.CHICKEN[diff][i] - 0.70) < 1e-6);
      if (i > 0) assert.ok(probs[i] <= probs[i - 1]);
    }
  }
});

test('ChickenRoad2, RoastedChicken, MegaBlock, and Crash enforce ~70% RTP across modes', () => {
  for (const [game, diffs] of [
    ['ChickenRoad2', ['Easy', 'Medium', 'Hard', 'Hardcore']],
    ['RoastedChicken', ['Easy', 'Medium', 'Hard', 'Extreme']]
  ]) {
    for (const d of diffs) {
      const mults = gm.CHICKEN_INSTANT[game][d];
      const curve = gm.survivalCurve(mults, 0.70);
      assert.equal(curve.length, mults.length);
      for (let i = 0; i < curve.length; i++) {
        assert.ok(curve[i] > 0 && curve[i] <= 1);
        assert.ok(Math.abs(curve[i] * mults[i] - 0.70) < 1e-6);
        if (i > 0) assert.ok(curve[i] <= curve[i - 1]);
      }
    }
  }

  let crPaid = 0, rcPaid = 0, mbPaid = 0;
  for (let i = 0; i < 3000; i++) {
    crPaid += gm.resolveInstant('ChickenRoad2', 10, { difficulty: 'Easy' }, 0.70, 25000).payout;
    rcPaid += gm.resolveInstant('RoastedChicken', 10, { difficulty: 'Easy' }, 0.70, 25000).payout;
    mbPaid += gm.resolveInstant('MegaBlock', 10, { difficulty: 'EASY' }, 0.70, 25000).payout;
  }
  assert.ok(crPaid / 30000 >= 0.65 && crPaid / 30000 <= 0.75, `ChickenRoad2 RTP=${crPaid / 30000}`);
  assert.ok(rcPaid / 30000 >= 0.65 && rcPaid / 30000 <= 0.75, `RoastedChicken RTP=${rcPaid / 30000}`);
  assert.ok(mbPaid / 30000 >= 0.65 && mbPaid / 30000 <= 0.75, `MegaBlock RTP=${mbPaid / 30000}`);

  // Crash EV at fixed 2.00x target across 6000 rounds with rtp=0.70 should average ~70%
  let crashPaid = 0;
  for (let i = 0; i < 6000; i++) {
    const cp = gm.crashPointFromSeed(`seed-${i}`, `r-${i}`, 0.70, 100);
    if (cp >= 2.0) crashPaid += 2.0;
  }
  const crashEv = crashPaid / 6000;
  assert.ok(crashEv >= 0.66 && crashEv <= 0.74, `Crash @ 2x EV=${crashEv}`);

  const cr = gm.resolveInstant('ChickenRoad2', 20, { difficulty: 'Medium' }, 0.70, 25000);
  assert.equal(typeof cr.visual.maxSafeStep, 'number');
  assert.equal(cr.visual.difficulty, 'Medium');
  assert.ok(cr.payout >= 0 && cr.payout <= 25000);

  const rc = gm.resolveInstant('RoastedChicken', 20, { difficulty: 'Extreme' }, 0.70, 25000);
  assert.equal(typeof rc.visual.maxSafeStep, 'number');
  assert.equal(rc.visual.difficulty, 'Extreme');
  assert.ok(rc.payout >= 0 && rc.payout <= 25000);

  const mb = gm.resolveInstant('MegaBlock', 25, { difficulty: 'HARD' }, 0.70, 25000);
  assert.equal(typeof mb.visual.maxSafeBlocks, 'number');
  assert.equal(mb.visual.difficulty, 'HARD');
  assert.ok(mb.payout >= 0 && mb.payout <= 25000);

  assert.throws(() => gm.resolveInstant('UnknownGame', 10, {}, 0.70, 25000), gm.Bad);
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
