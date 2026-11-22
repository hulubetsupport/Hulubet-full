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

module.exports = {
  SPIN_COOLDOWN_MS,
  SPIN_SLICES,
  rollSpinPrize,
  getSpinAvailability,
  computeClaimableCashback
};
