'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SPIN_COOLDOWN_MS,
  SPIN_SLICES,
  rollSpinPrize,
  getSpinAvailability,
  computeClaimableCashback
} = require('./bonus-engine');
const {
  createDefaultFixtures,
  tickMatch,
  evaluateMarketResult,
  computeCashoutValue
} = require('./sports-engine');

test('Lucky Spin rollSpinPrize maps weighted rolls accurately across all 8 slices', () => {
  const first = rollSpinPrize(() => 0.0);
  assert.equal(first.sliceIndex, 0);
  assert.equal(first.amount, 0);

  const jackpot = rollSpinPrize(() => 0.9999);
  assert.equal(jackpot.sliceIndex, SPIN_SLICES.length - 1);
  assert.equal(jackpot.amount, 100);

  const mid = rollSpinPrize(() => 0.45);
  assert.ok(mid.sliceIndex >= 0 && mid.sliceIndex < SPIN_SLICES.length);
  assert.equal(mid.amount, SPIN_SLICES[mid.sliceIndex].amount);
});

test('Lucky Spin cooldown enforces 24h wait window', () => {
  const now = 1_750_000_000_000;
  assert.equal(getSpinAvailability(null, now).canSpin, true);

  const recent = new Date(now - 60 * 60 * 1000).toISOString();
  const availLocked = getSpinAvailability(recent, now);
  assert.equal(availLocked.canSpin, false);
  assert.equal(availLocked.remainingMs, SPIN_COOLDOWN_MS - 3_600_000);
  assert.ok(availLocked.nextSpinAt);

  const expired = new Date(now - SPIN_COOLDOWN_MS - 1000).toISOString();
  assert.equal(getSpinAvailability(expired, now).canSpin, true);
});

test('Cashback calculation pays only on unclaimed net loss above cutoff', () => {
  const c1 = computeClaimableCashback({ totalWagered: 500, totalWon: 200, settledLoss: 0, percent: 10, minLoss: 100 });
  assert.equal(c1.totalNetLoss, 300);
  assert.equal(c1.unclaimedLoss, 300);
  assert.equal(c1.eligible, true);
  assert.equal(c1.cashbackAmount, 30);

  const c2 = computeClaimableCashback({ totalWagered: 500, totalWon: 200, settledLoss: 250, percent: 10, minLoss: 100 });
  assert.equal(c2.unclaimedLoss, 50);
  assert.equal(c2.eligible, false);
  assert.equal(c2.cashbackAmount, 0);
});

test('Sports engine ticks match to FT and evaluates 1/X/2 + Over/Under 2.5 markets', () => {
  let fixtures = createDefaultFixtures(1000);
  assert.ok(fixtures.length >= 4);
  let f = fixtures[0];
  assert.equal(f.status, 'LIVE');

  for (let i = 0; i < 15; i++) {
    f = tickMatch(f, () => 0.99);
  }
  assert.equal(f.status, 'FT');
  assert.equal(f.minute, 'FT');

  const sample = { home: 'Arsenal FC', away: 'Real Madrid', homeScore: 2, awayScore: 1 };
  assert.equal(evaluateMarketResult('Arsenal FC Win', sample), true);
  assert.equal(evaluateMarketResult('Draw', sample), false);
  assert.equal(evaluateMarketResult('Real Madrid Win', sample), false);
  assert.equal(evaluateMarketResult('Over 2.5 Goals', sample), true);
  assert.equal(evaluateMarketResult('Under 2.5 Goals', sample), false);

  const tieSample = { home: 'St. George SC', away: 'Ethiopian Coffee', homeScore: 1, awayScore: 1 };
  assert.equal(evaluateMarketResult('Draw', tieSample), true);
  assert.equal(evaluateMarketResult('Under 2.5 Goals', tieSample), true);
});

test('Live cashout adjusts higher for winning positions and drops to 0 when Under 2.5 busts', () => {
  const [soccer] = createDefaultFixtures(1000);
  // soccer is Arsenal 2 - 1 Real Madrid (3 goals scored)
  const overTicket = { stake: 100, potential_win: 180, market: 'Over 2.5 Goals' };
  const underTicket = { stake: 100, potential_win: 210, market: 'Under 2.5 Goals' };
  const homeTicket = { stake: 100, potential_win: 215, market: 'Arsenal FC Win' };

  assert.equal(computeCashoutValue(underTicket, soccer), 0);
  assert.ok(computeCashoutValue(overTicket, soccer) > 160);
  assert.ok(computeCashoutValue(homeTicket, soccer) > 80);
});
