'use strict';
const crypto = require('crypto');
const { r2, num } = require('./game-math');

const SPIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const SPIN_SLICES = [
  { label: '0 ETB', amount: 0, weight: 30 },
  { label: '2 ETB', amount: 2, weight: 28 },
  { label: '5 ETB', amount: 5, weight: 20 },
  { label: '10 ETB', amount: 10, weight: 12 },
  { label: '15 ETB', amount: 15, weight: 5 },
  { label: '25 ETB', amount: 25, weight: 3 },
  { label: '50 ETB', amount: 50, weight: 1.5 },
  { label: '100 ETB', amount: 100, weight: 0.5 }
];

function rollSpinPrize(randUnitFn) {
  const totalWeight = SPIN_SLICES.reduce((acc, s) => acc + s.weight, 0);
  const u = typeof randUnitFn === 'function'
    ? Math.max(0, Math.min(0.999999999, Number(randUnitFn())))
    : crypto.randomInt(0, 1_000_000) / 1_000_000;
  let roll = u * totalWeight;
  for (let i = 0; i < SPIN_SLICES.length; i++) {
    if (roll < SPIN_SLICES[i].weight) {
      return { sliceIndex: i, label: SPIN_SLICES[i].label, amount: SPIN_SLICES[i].amount };
    }
    roll -= SPIN_SLICES[i].weight;
  }
  const last = SPIN_SLICES.length - 1;
  return { sliceIndex: last, label: SPIN_SLICES[last].label, amount: SPIN_SLICES[last].amount };
}

function getSpinAvailability(lastSpinAt, nowMs = Date.now()) {
  if (!lastSpinAt) {
    return { canSpin: true, nextSpinAt: null, remainingMs: 0 };
  }
  const lastMs = new Date(lastSpinAt).getTime();
  if (!Number.isFinite(lastMs)) {
    return { canSpin: true, nextSpinAt: null, remainingMs: 0 };
  }
  const unlockAt = lastMs + SPIN_COOLDOWN_MS;
  const remainingMs = Math.max(0, unlockAt - nowMs);
  return {
    canSpin: remainingMs === 0,
    nextSpinAt: remainingMs > 0 ? new Date(unlockAt).toISOString() : null,
    remainingMs
  };
}

function computeClaimableCashback({ totalWagered, totalWon, settledLoss, percent = 10, minLoss = 100 }) {
  const totalNetLoss = Math.max(0, r2(num(totalWagered) - num(totalWon)));
  const settled = Math.max(0, r2(num(settledLoss)));
  const unclaimedLoss = Math.max(0, r2(totalNetLoss - settled));
  const pct = Math.min(50, Math.max(1, num(percent)));
  const minCutoff = Math.max(1, num(minLoss));
  const eligible = unclaimedLoss >= minCutoff;
  const cashbackAmount = eligible ? r2(unclaimedLoss * (pct / 100)) : 0;
  return {
    totalNetLoss,
    unclaimedLoss,
    percent: pct,
    minLoss: minCutoff,
    eligible,
    cashbackAmount
  };
}

const DEFAULT_BONUS_WAGER_MULT = 50;
const DEFAULT_DEPOSIT_ODD_REQ = 5;
const DEFAULT_DEPOSIT_WAGER_MULT = DEFAULT_DEPOSIT_ODD_REQ;
const DEFAULT_FIRST_DEP_MIN = 300;
const DEFAULT_FIRST_DEP_PCT = 20;

function computeFirstDepositBonus({
  amount,
  isFirstDeposit,
  minAmount = DEFAULT_FIRST_DEP_MIN,
  percent = DEFAULT_FIRST_DEP_PCT,
  wagerMult = DEFAULT_BONUS_WAGER_MULT
}) {
  const amt = r2(num(amount));
  const minCutoff = Math.max(0, r2(num(minAmount)));
  const pct = Math.max(0, Math.min(200, num(percent)));
  const mult = Math.max(1, num(wagerMult));
  if (!isFirstDeposit || !(amt >= minCutoff) || pct <= 0) {
    return { eligible: false, bonusAmount: 0, wagerAdded: 0, percent: pct, minAmount: minCutoff };
  }
  const bonusAmount = r2(amt * (pct / 100));
  const wagerAdded = r2(bonusAmount * mult);
  return {
    eligible: bonusAmount > 0,
    bonusAmount,
    wagerAdded,
    percent: pct,
    minAmount: minCutoff
  };
}

/**
 * Updates bonus balance, wagering requirement, and remaining deposit odd requirement on a wager:
 * - Depositors consume bonus_balance FIRST on every bet; once bonus_balance reaches 0, wager_requirement_left clears to 0.
 * - Bonus-only players (never deposited) must complete full 50x wager_requirement_left before unlocking bonus_balance.
 * - Depositors also decrement deposit_odds_left by oddDelta (e.g. sports odd or game round odd/multiplier).
 */
function computeBetProgress({
  bonusBalance = 0,
  wagerRequirementLeft = 0,
  totalDeposited = 0,
  firstDepositCompleted = 'NO',
  depositOddsLeft = 0,
  wager = 0,
  oddDelta = 0
}) {
  const curBonus = Math.max(0, r2(num(bonusBalance)));
  const curWr = Math.max(0, r2(num(wagerRequirementLeft)));
  const curOddsLeft = Math.max(0, r2(num(depositOddsLeft)));
  const betAmt = Math.max(0, r2(num(wager)));
  const oddsPlayed = Math.max(0, r2(num(oddDelta)));
  const hasDeposited = num(totalDeposited) > 0 || String(firstDepositCompleted).toUpperCase() === 'YES';

  let newBonusBalance;
  let newWagerRequirementLeft;
  if (hasDeposited) {
    newBonusBalance = Math.max(0, r2(curBonus - betAmt));
    newWagerRequirementLeft = newBonusBalance === 0 ? 0 : Math.max(0, r2(curWr - betAmt));
    if (newWagerRequirementLeft === 0) newBonusBalance = 0;
  } else {
    newWagerRequirementLeft = Math.max(0, r2(curWr - betAmt));
    newBonusBalance = newWagerRequirementLeft === 0 ? 0 : curBonus;
  }

  const newDepositOddsLeft = hasDeposited ? Math.max(0, r2(curOddsLeft - oddsPlayed)) : 0;
  return {
    hasDeposited,
    newBonusBalance,
    newWagerRequirementLeft,
    newDepositOddsLeft
  };
}

function computeSettlementOdds({
  totalDeposited = 0,
  firstDepositCompleted = 'NO',
  depositOddsLeft = 0,
  oddDelta = 0
}) {
  const hasDeposited = num(totalDeposited) > 0 || String(firstDepositCompleted).toUpperCase() === 'YES';
  if (!hasDeposited) return 0;
  return Math.max(0, r2(Math.max(0, num(depositOddsLeft)) - Math.max(0, num(oddDelta))));
}

function computeWithdrawableBalance({
  balance,
  bonusBalance,
  wagerRequirementLeft,
  totalDeposited = 0,
  depositOddsLeft = 0,
  firstDepositCompleted = 'NO',
  depositOddReq = DEFAULT_DEPOSIT_ODD_REQ
}) {
  const bal = Math.max(0, r2(num(balance)));
  const bonus = Math.max(0, r2(num(bonusBalance)));
  const wrLeft = Math.max(0, r2(num(wagerRequirementLeft)));
  const oddReq = Math.max(1, r2(num(depositOddReq)));
  const hasDeposited = num(totalDeposited) > 0 || String(firstDepositCompleted).toUpperCase() === 'YES';
  const oddsLeft = hasDeposited ? Math.max(0, r2(num(depositOddsLeft))) : 0;
  const lockedBonus = wrLeft > 0 ? Math.min(bal, bonus) : 0;
  return {
    totalBalance: bal,
    lockedBonus,
    withdrawableBalance: Math.max(0, r2(bal - lockedBonus)),
    wagerRequirementLeft: wrLeft,
    depositOddReq: oddReq,
    depositOddsLeft: oddsLeft,
    depositWagerMult: oddReq,
    depositWagerLeft: oddsLeft
  };
}

/**
 * Evaluates withdrawal eligibility:
 * - Depositors: bonus is eaten first when playing; MUST play >= 5 odds total (depositOddsLeft === 0).
 * - Bonus-only players (no deposit): MUST complete 50x bonus wagering (wagerRequirementLeft === 0).
 */
function evaluateWithdrawalEligibility({
  amount,
  balance,
  bonusBalance,
  wagerRequirementLeft,
  totalDeposited = 0,
  depositOddsLeft = 0,
  firstDepositCompleted = 'NO',
  bonusWagerMult = DEFAULT_BONUS_WAGER_MULT,
  depositOddReq = DEFAULT_DEPOSIT_ODD_REQ
}) {
  const amt = r2(num(amount));
  const wInfo = computeWithdrawableBalance({
    balance,
    bonusBalance,
    wagerRequirementLeft,
    totalDeposited,
    depositOddsLeft,
    firstDepositCompleted,
    depositOddReq
  });
  const hasDeposited = num(totalDeposited) > 0 || String(firstDepositCompleted).toUpperCase() === 'YES';
  if (wInfo.totalBalance < amt) {
    return { allowed: false, reason: 'Insufficient balance', wInfo };
  }
  if (!hasDeposited) {
    if (wInfo.wagerRequirementLeft > 0) {
      return {
        allowed: false,
        reason: `Bonus play requires ${bonusWagerMult}x wagering (${wInfo.wagerRequirementLeft.toFixed(2)} ETB left) before withdrawal`,
        wInfo
      };
    }
    if (amt > wInfo.withdrawableBalance) {
      return { allowed: false, reason: `Insufficient withdrawable balance (max ${wInfo.withdrawableBalance.toFixed(2)} ETB)`, wInfo };
    }
    return { allowed: true, reason: '', wInfo };
  }

  // Depositor: must play 5 odds (depositOddsLeft === 0)
  if (wInfo.depositOddsLeft > 0) {
    return {
      allowed: false,
      reason: `Deposited funds require playing ${wInfo.depositOddReq} odds (${wInfo.depositOddsLeft.toFixed(2)} odds left) before withdrawal`,
      wInfo
    };
  }
  if (amt > wInfo.withdrawableBalance) {
    const msg = (wInfo.lockedBonus > 0 && wInfo.wagerRequirementLeft > 0)
      ? `Max withdrawable real balance is ${wInfo.withdrawableBalance.toFixed(2)} ETB (play through ${wInfo.lockedBonus.toFixed(2)} ETB remaining bonus credit first)`
      : `Insufficient withdrawable balance (max ${wInfo.withdrawableBalance.toFixed(2)} ETB)`;
    return { allowed: false, reason: msg, wInfo };
  }
  return { allowed: true, reason: '', wInfo };
}

module.exports = {
  SPIN_COOLDOWN_MS,
  SPIN_SLICES,
  DEFAULT_BONUS_WAGER_MULT,
  DEFAULT_DEPOSIT_ODD_REQ,
  DEFAULT_DEPOSIT_WAGER_MULT,
  DEFAULT_FIRST_DEP_MIN,
  DEFAULT_FIRST_DEP_PCT,
  rollSpinPrize,
  getSpinAvailability,
  computeClaimableCashback,
  computeFirstDepositBonus,
  computeBetProgress,
  computeSettlementOdds,
  computeWithdrawableBalance,
  evaluateWithdrawalEligibility
};
