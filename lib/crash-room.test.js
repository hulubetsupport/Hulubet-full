'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomState, curveMultAt, WAIT_MS, CRASH_PAUSE_MS } = require('./crash-room');

function makeTestRoom(crashPoint = 2.5) {
  let seq = 1;
  return createRoomState('Aviator', () => ({
    roundId: `RND-TEST-${seq++}`,
    seed: 'seed-secret-hex-' + seq,
    commit: 'commit-hash-' + seq,
    crashPoint
  }));
}

test('crash-room hides crashPoint & seed during WAITING and FLYING, reveals on CRASHED', () => {
  const mgr = makeTestRoom(2.2);
  const t0 = 100000;
  const waitSnap = mgr.startWaiting(t0);
  assert.equal(waitSnap.phase, 'WAITING');
  assert.equal(waitSnap.crashPoint, undefined);
  assert.equal(waitSnap.serverSeed, undefined);

  const flySnap = mgr.takeoff(t0 + WAIT_MS);
  assert.equal(flySnap.phase, 'FLYING');
  assert.equal(flySnap.crashPoint, undefined);
  assert.equal(flySnap.serverSeed, undefined);
});

test('crash-room handles bet queuing, cancel before takeoff, auto-cashout, and crash settlement', () => {
  const mgr = makeTestRoom(2.0);
  const t0 = 500000;
  mgr.startWaiting(t0);

  assert.equal(mgr.addQueuedBet({ betId: 'B1', userId: 'u1', username: 'Abebe', panelIndex: 0, wager: 100, auto: 1.5 }), true);
  assert.equal(mgr.addQueuedBet({ betId: 'B2', userId: 'u2', username: 'Kebede', panelIndex: 0, wager: 50, auto: null }), true);
  assert.equal(mgr.addQueuedBet({ betId: 'B3', userId: 'u1', username: 'Abebe', panelIndex: 1, wager: 25, auto: null }), true);

  const cancelled = mgr.removeQueuedBet('B3', 'u1');
  assert.equal(cancelled.betId, 'B3');
  assert.equal(mgr.room.bets.length, 2);

  // Advance to takeoff
  const resTakeoff = mgr.stepTick(t0 + WAIT_MS);
  assert.equal(resTakeoff.event, 'TAKEOFF');
  assert.equal(mgr.removeQueuedBet('B1', 'u1'), null);

  // Advance until mult >= 1.50 (but < 2.00)
  let flyTime = t0 + WAIT_MS;
  while (curveMultAt((flyTime - (t0 + WAIT_MS)) / 1000) < 1.55) {
    flyTime += 100;
  }
  const resTick = mgr.stepTick(flyTime);
  assert.equal(resTick.event, 'TICK');
  assert.equal(resTick.autoWins.length, 1);
  assert.equal(resTick.autoWins[0].betId, 'B1');
  assert.equal(resTick.autoWins[0].payout, 150);

  // Advance until crash at 2.00
  while (curveMultAt((flyTime - (t0 + WAIT_MS)) / 1000) < 2.05) {
    flyTime += 100;
  }
  const resCrash = mgr.stepTick(flyTime);
  assert.equal(resCrash.event, 'CRASHED');
  assert.equal(resCrash.crashedBets.length, 1);
  assert.equal(resCrash.crashedBets[0].betId, 'B2');
  assert.equal(resCrash.snapshot.crashPoint, 2.0);
  assert.ok(resCrash.snapshot.serverSeed);
  assert.equal(resCrash.snapshot.history.length, 1);

  // Next round starts after CRASH_PAUSE_MS
  const resNext = mgr.stepTick(flyTime + CRASH_PAUSE_MS + 10);
  assert.equal(resNext.event, 'NEW_ROUND');
  assert.equal(resNext.snapshot.phase, 'WAITING');
  assert.equal(resNext.snapshot.bets.length, 0);
});

test('crash-room settles manual cashout once and rejects post-crash cashout', () => {
  const mgr = makeTestRoom(3.5);
  const t0 = 10000;
  mgr.startWaiting(t0);
  mgr.addQueuedBet({ betId: 'BM1', userId: 'u9', username: 'Sara', panelIndex: 0, wager: 100, auto: null });
  mgr.takeoff(t0 + WAIT_MS);

  let flyTime = t0 + WAIT_MS + 4000; // ~1.5x
  const expectedMult = curveMultAt(4);
  const out = mgr.settleManualCashout('BM1', 'u9', flyTime, expectedMult);
  assert.equal(out.ok, true);
  assert.equal(out.bet.multiplier, expectedMult);
  assert.equal(out.bet.payout, Math.round(100 * expectedMult * 100) / 100);

  // Double cashout rejected
  const dup = mgr.settleManualCashout('BM1', 'u9', flyTime + 100, expectedMult);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'ALREADY_SETTLED');
});
