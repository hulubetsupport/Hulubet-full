'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SPIN_COOLDOWN_MS,
  SPIN_SLICES,
  DEFAULT_BONUS_WAGER_MULT,
  DEFAULT_DEPOSIT_WAGER_MULT,
  DEFAULT_FIRST_DEP_MIN,
  DEFAULT_FIRST_DEP_PCT,
  rollSpinPrize,
  getSpinAvailability,
  computeClaimableCashback,
  computeFirstDepositBonus,
  computeWithdrawableBalance,
  evaluateWithdrawalEligibility
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

test('First Deposit Bonus grants 20% on first deposit >= 300 ETB with 50x wagering only', () => {
  assert.equal(DEFAULT_BONUS_WAGER_MULT, 50);
  assert.equal(DEFAULT_FIRST_DEP_MIN, 300);
  assert.equal(DEFAULT_FIRST_DEP_PCT, 20);

  const below = computeFirstDepositBonus({ amount: 250, isFirstDeposit: true });
  assert.equal(below.eligible, false);
  assert.equal(below.bonusAmount, 0);
  assert.equal(below.wagerAdded, 0);

  const eligible = computeFirstDepositBonus({ amount: 300, isFirstDeposit: true });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.bonusAmount, 60);
  assert.equal(eligible.wagerAdded, 3000);

  const repeat = computeFirstDepositBonus({ amount: 1000, isFirstDeposit: false });
  assert.equal(repeat.eligible, false);
  assert.equal(repeat.bonusAmount, 0);
});

test('Withdrawable balance locks bonus credit until 50x wagering completes', () => {
  const locked = computeWithdrawableBalance({ balance: 620, bonusBalance: 120, wagerRequirementLeft: 6000 });
  assert.equal(locked.lockedBonus, 120);
  assert.equal(locked.withdrawableBalance, 500);
  assert.equal(locked.wagerRequirementLeft, 6000);

  const cleared = computeWithdrawableBalance({ balance: 620, bonusBalance: 120, wagerRequirementLeft: 0 });
  assert.equal(cleared.lockedBonus, 0);
  assert.equal(cleared.withdrawableBalance, 620);
  assert.equal(cleared.wagerRequirementLeft, 0);
});

test('Withdrawal eligibility: 50x bonus-only vs 5x mandatory for depositors', () => {
  assert.equal(DEFAULT_DEPOSIT_WAGER_MULT, 5);

  // Bonus-only player with uncleared 50x is blocked
  const bBlocked = evaluateWithdrawalEligibility({
    amount: 100, balance: 250, bonusBalance: 20, wagerRequirementLeft: 400, totalDeposited: 0, totalWagered: 600
  });
  assert.equal(bBlocked.allowed, false);
  assert.match(bBlocked.reason, /50x wagering/);

  // Bonus-only player who cleared 50x can withdraw
  const bAllowed = evaluateWithdrawalEligibility({
    amount: 100, balance: 250, bonusBalance: 20, wagerRequirementLeft: 0, totalDeposited: 0, totalWagered: 1000
  });
  assert.equal(bAllowed.allowed, true);

  // Depositor under 5x deposit turnover (500 * 5 = 2500) is blocked by 5x rule, NOT 50x
  const dUnder5x = evaluateWithdrawalEligibility({
    amount: 100, balance: 620, bonusBalance: 120, wagerRequirementLeft: 5500, totalDeposited: 500, totalWagered: 1200, firstDepositCompleted: 'YES'
  });
  assert.equal(dUnder5x.allowed, false);
  assert.match(dUnder5x.reason, /5x wagering/i);

  // Depositor at >= 5x deposit turnover can withdraw real balance even with active 50x bonus left
  const dAt5x = evaluateWithdrawalEligibility({
    amount: 400, balance: 620, bonusBalance: 120, wagerRequirementLeft: 3500, totalDeposited: 500, totalWagered: 2500, firstDepositCompleted: 'YES'
  });
  assert.equal(dAt5x.allowed, true);

  // Depositor still cannot cash out the locked 120 bonus itself before 50x completes
  const dBonusPortion = evaluateWithdrawalEligibility({
    amount: 550, balance: 620, bonusBalance: 120, wagerRequirementLeft: 3500, totalDeposited: 500, totalWagered: 2500, firstDepositCompleted: 'YES'
  });
  assert.equal(dBonusPortion.allowed, false);
  assert.match(dBonusPortion.reason, /50x wagering/i);
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
