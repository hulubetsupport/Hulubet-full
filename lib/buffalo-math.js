'use strict';
const crypto = require('crypto');

const ROWS = 4;
const COLS = 5;

const PAYLINES = [
  [0, 0, 0, 0, 0], // 1
  [1, 1, 1, 1, 1], // 2
  [2, 2, 2, 2, 2], // 3
  [3, 3, 3, 3, 3], // 4
  [0, 1, 2, 1, 0], // 5
  [1, 2, 3, 2, 1], // 6
  [2, 1, 0, 1, 2], // 7
  [3, 2, 1, 2, 3], // 8
  [0, 1, 1, 1, 0], // 9
  [1, 2, 2, 2, 1], // 10
  [2, 3, 3, 3, 2], // 11
  [1, 0, 0, 0, 1], // 12
  [2, 1, 1, 1, 2], // 13
  [3, 2, 2, 2, 3], // 14
  [0, 0, 1, 0, 0], // 15
  [1, 1, 2, 1, 1], // 16
  [2, 2, 3, 2, 2], // 17
  [1, 1, 0, 1, 1], // 18
  [2, 2, 1, 2, 2], // 19
  [3, 3, 2, 3, 3]  // 20
];

const PAYTABLE = {
  buffalo: { 5: 50, 4: 10, 3: 5, 2: 0.5 },
  eagle:   { 5: 20, 4: 7.5, 3: 3 },
  wolf:    { 5: 15, 4: 7, 3: 2 },
  cougar:  { 5: 10, 4: 5, 3: 1 },
  horse:   { 5: 7,  4: 2, 3: 0.5 },
  A:       { 5: 5,  4: 1.5, 3: 0.3 },
  K:       { 5: 5,  4: 1.5, 3: 0.3 },
  Q:       { 5: 3,  4: 1, 3: 0.2 },
  J:       { 5: 3,  4: 1, 3: 0.2 },
  '10':    { 5: 3,  4: 1, 3: 0.2 }
};

const SCATTER_PAY = { 5: 20, 4: 5, 3: 1 };
const FREE_SPINS_INIT = { 5: 20, 4: 12, 3: 8 };
const FREE_SPINS_RETRIGGER = { 5: 20, 4: 12, 3: 8, 2: 5 };

const JACKPOTS = {
  MINI: 50,
  MEGA: 150,
  SUPER: 500,
  GRAND: 5000
};

const BET_STEPS = [2, 5, 10, 20, 40, 50, 100, 200, 500, 1000];
const BASE_CALIBRATED_RTP = 0.70;

// Calibrated 5x4 weights yielding ~70% RTP naturally across Main Spins, Buy FS (100x), and Buy BG (80x)
const REGULAR_WEIGHTS_COL0 = [
  ['buffalo', 3],
  ['eagle',   4],
  ['wolf',    5],
  ['cougar',  8],
  ['horse',   11],
  ['A',       18],
  ['K',       18],
  ['Q',       26],
  ['J',       26],
  ['10',      28]
];

const REGULAR_WEIGHTS_REST = [
  ['buffalo', 4],
  ['eagle',   5],
  ['wolf',    7],
  ['cougar',  9],
  ['horse',   12],
  ['A',       18],
  ['K',       18],
  ['Q',       25],
  ['J',       25],
  ['10',      27]
];

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const rFloat = () => crypto.randomInt(0, 1000000) / 1000000;
const rInt = max => crypto.randomInt(0, max);

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = rInt(i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

function pickWeighted(table) {
  let total = 0;
  for (let i = 0; i < table.length; i++) total += table[i][1];
  let r = rFloat() * total;
  for (let i = 0; i < table.length; i++) {
    r -= table[i][1];
    if (r <= 0) return table[i][0];
  }
  return table[0][0];
}

function formatCompactCoin(v) {
  if (v >= 100000) return Math.round(v / 1000) + 'K';
  return Number.isInteger(v) ? String(v) : String(Math.round(v));
}

function makeCoinData(bet) {
  const roll = rFloat();
  if (roll < 0.0002) return { coinVal: r2(bet * JACKPOTS.SUPER), coinLabel: 'SUPER' };
  if (roll < 0.0012) return { coinVal: r2(bet * JACKPOTS.MEGA), coinLabel: 'MEGA' };
  if (roll < 0.009) return { coinVal: r2(bet * JACKPOTS.MINI), coinLabel: 'MINI' };
  const mults = [1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 10];
  const m = mults[rInt(mults.length)];
  const val = r2(bet * m);
  return { coinVal: val, coinLabel: formatCompactCoin(val) };
}

function generateSpinGrid(mode, bet, forcedTrigger = null) {
  const grid = Array.from({ length: COLS }, () => Array(ROWS).fill(null));
  const inFS = mode === 'freespins';

  let forcedScatterCols = [];
  let forcedBonusCells = [];
  if (forcedTrigger === 'freespins') {
    const count = rFloat() < 0.10 ? 4 : 3;
    forcedScatterCols = shuffle([0, 1, 2, 3, 4]).slice(0, count);
  } else if (forcedTrigger === 'bonus') {
    const allPos = [];
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) allPos.push([c, r]);
    forcedBonusCells = shuffle(allPos).slice(0, 8);
  }

  for (let c = 0; c < COLS; c++) {
    let hasScatterInCol = false;
    const weights = c === 0 ? REGULAR_WEIGHTS_COL0 : REGULAR_WEIGHTS_REST;
    for (let r = 0; r < ROWS; r++) {
      if (forcedBonusCells.some(([fc, fr]) => fc === c && fr === r)) {
        grid[c][r] = { id: 'bonus', mult: 0, ...makeCoinData(bet) };
        continue;
      }
      if (forcedScatterCols.includes(c) && !hasScatterInCol && r === rInt(ROWS)) {
        grid[c][r] = { id: 'scatter', mult: 0 };
        hasScatterInCol = true;
        continue;
      }

      const roll = rFloat();
      const wildP = inFS ? 0.087 : 0.042;
      const scatP = inFS ? 0.020 : 0.0092;
      const coinP = inFS ? 0.045 : 0.055;

      if (c >= 1 && c <= 3 && roll < wildP) {
        let mult = 0;
        if (inFS) {
          mult = rFloat() < 0.72 ? 2 : 3;
        } else {
          const mr = rFloat();
          if (mr < 0.25) mult = 2;
          else if (mr < 0.35) mult = 3;
        }
        grid[c][r] = { id: 'wild', mult };
      } else if (!hasScatterInCol && roll < wildP + scatP) {
        grid[c][r] = { id: 'scatter', mult: 0 };
        hasScatterInCol = true;
      } else if (roll < wildP + scatP + coinP) {
        grid[c][r] = { id: 'bonus', mult: 0, ...makeCoinData(bet) };
      } else {
        grid[c][r] = { id: pickWeighted(weights), mult: 0 };
      }
    }
    if (forcedScatterCols.includes(c) && !hasScatterInCol) {
      grid[c][rInt(ROWS)] = { id: 'scatter', mult: 0 };
    }
  }
  return grid;
}

function evaluateSpin(grid, bet) {
  const lineWins = [];
  let totalWin = 0;

  for (let li = 0; li < PAYLINES.length; li++) {
    const line = PAYLINES[li];
    const firstCell = grid[0][line[0]];
    if (firstCell.id === 'scatter' || firstCell.id === 'bonus' || firstCell.id === 'wild') {
      continue;
    }
    const target = firstCell.id;
    let count = 1;
    let multSum = 0;
    const cells = [[0, line[0]]];

    for (let c = 1; c < COLS; c++) {
      const cell = grid[c][line[c]];
      if (cell.id === target || cell.id === 'wild') {
        count++;
        cells.push([c, line[c]]);
        if (cell.id === 'wild' && (cell.mult === 2 || cell.mult === 3)) {
          multSum += cell.mult;
        }
      } else {
        break;
      }
    }

    const payMap = PAYTABLE[target];
    if (payMap && payMap[count]) {
      const effectiveMult = multSum > 0 ? multSum : 1;
      const winAmt = r2(bet * payMap[count] * effectiveMult);
      totalWin = r2(totalWin + winAmt);
      lineWins.push({
        lineIndex: li,
        lineNumber: li + 1,
        symbol: target,
        count,
        mult: effectiveMult,
        amount: winAmt,
        cells
      });
    }
  }

  const scatterCells = [];
  const bonusCells = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (grid[c][r].id === 'scatter') scatterCells.push([c, r]);
      if (grid[c][r].id === 'bonus') bonusCells.push([c, r]);
    }
  }

  let scatterWin = 0;
  const scCount = Math.min(5, scatterCells.length);
  if (SCATTER_PAY[scCount]) {
    scatterWin = r2(bet * SCATTER_PAY[scCount]);
    totalWin = r2(totalWin + scatterWin);
  }

  return {
    totalWin,
    lineWins,
    scatterCells,
    scatterWin,
    scatterCount: scatterCells.length,
    bonusCells,
    bonusCount: bonusCells.length
  };
}

function simulateBonusGame(triggerGrid, bet) {
  const bGrid = Array.from({ length: COLS }, (_, c) =>
    Array.from({ length: ROWS }, (_, r) =>
      triggerGrid[c][r].id === 'bonus' ? { ...triggerGrid[c][r] } : null
    )
  );

  let lockedCount = 0;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (bGrid[c][r]) lockedCount++;
    }
  }

  let respinsLeft = 3;
  const steps = [];
  while (respinsLeft > 0 && lockedCount < 20) {
    respinsLeft--;
    const added = [];
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        if (!bGrid[c][r] && rFloat() < 0.058) {
          const coin = { id: 'bonus', mult: 0, ...makeCoinData(bet) };
          bGrid[c][r] = coin;
          lockedCount++;
          added.push({ c, r, cell: coin });
        }
      }
    }
    if (added.length > 0) respinsLeft = 3;
    steps.push({ added, lockedCount, respinsLeft });
  }

  let totalWin = 0;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (bGrid[c][r]) totalWin = r2(totalWin + bGrid[c][r].coinVal);
    }
  }
  const fullBoardGrand = lockedCount === 20;
  const grandVal = fullBoardGrand ? r2(bet * JACKPOTS.GRAND) : 0;
  if (fullBoardGrand) totalWin = r2(totalWin + grandVal);

  return {
    initialGrid: triggerGrid.map(col => col.map(cell => (cell.id === 'bonus' ? { ...cell } : null))),
    steps,
    finalGrid: bGrid,
    lockedCount,
    fullBoardGrand,
    grandVal,
    totalWin
  };
}

function simulateSingleRound(bet, bonusBuy = null) {
  const forced = bonusBuy === 'freespins' ? 'freespins' : bonusBuy === 'bonus' ? 'bonus' : null;
  const baseGrid = generateSpinGrid('main', bet, forced);
  const baseEval = evaluateSpin(baseGrid, bet);
  let totalWin = baseEval.totalWin;

  let baseBonus = null;
  if (baseEval.bonusCount >= 8) {
    baseBonus = simulateBonusGame(baseGrid, bet);
    totalWin = r2(totalWin + baseBonus.totalWin);
  }

  const sc = Math.min(5, baseEval.scatterCount);
  let freeSpins = null;
  if (sc >= 3) {
    const initialSpins = FREE_SPINS_INIT[sc];
    let left = initialSpins;
    let totalFeatureWin = 0;
    const spins = [];
    let guard = 0;
    while (left > 0 && guard++ < 60) {
      left--;
      const grid = generateSpinGrid('freespins', bet);
      const evalRes = evaluateSpin(grid, bet);
      totalFeatureWin = r2(totalFeatureWin + evalRes.totalWin);

      let bonusGame = null;
      if (evalRes.bonusCount >= 8) {
        bonusGame = simulateBonusGame(grid, bet);
        totalFeatureWin = r2(totalFeatureWin + bonusGame.totalWin);
      }

      const fsc = Math.min(5, evalRes.scatterCount);
      const extraSpins = fsc >= 2 ? FREE_SPINS_RETRIGGER[fsc] : 0;
      if (extraSpins > 0) left += extraSpins;

      spins.push({ grid, eval: evalRes, bonusGame, extraSpins });
    }
    totalWin = r2(totalWin + totalFeatureWin);
    freeSpins = { initialSpins, totalWin: totalFeatureWin, spins };
  }

  return { baseGrid, baseEval, baseBonus, freeSpins, totalWin };
}

function resolveBuffaloSpin({ wager, rtp = BASE_CALIBRATED_RTP, maxPayout = 20000, bonusBuy = null } = {}) {
  const bet = r2(wager);
  if (!(bet >= 2)) throw new Error('Minimum bet is 2 ETB');
  const buyMode = bonusBuy === 'freespins' || bonusBuy === 'bonus' ? bonusBuy : null;
  const totalCost = buyMode === 'freespins' ? r2(bet * 100) : buyMode === 'bonus' ? r2(bet * 80) : bet;

  let round = simulateSingleRound(bet, buyMode);

  // If admin adjusts Buffalo RTP away from the 70% calibrated baseline, smoothly compensate
  const target = Math.min(0.99, Math.max(0.50, Number(rtp) || BASE_CALIBRATED_RTP));
  if (target < BASE_CALIBRATED_RTP - 0.01 && round.totalWin > 0) {
    if (rFloat() > target / BASE_CALIBRATED_RTP) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const alt = simulateSingleRound(bet, buyMode);
        if (alt.totalWin < round.totalWin) {
          round = alt;
          if (alt.totalWin === 0) break;
        }
      }
    }
  } else if (target > BASE_CALIBRATED_RTP + 0.01 && round.totalWin === 0 && !buyMode) {
    const boostProb = Math.min(0.35, (target - BASE_CALIBRATED_RTP) / (1 - BASE_CALIBRATED_RTP));
    if (rFloat() < boostProb) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const alt = simulateSingleRound(bet, null);
        if (alt.totalWin > 0) {
          round = alt;
          break;
        }
      }
    }
  }

  const rawPayout = r2(round.totalWin);
  const capped = rawPayout > maxPayout;
  const totalPayout = Math.min(rawPayout, maxPayout);
  const multiplier = totalCost > 0 ? r2(totalPayout / totalCost) : 0;
  const isWin = totalPayout > 0;

  let tier = buyMode === 'freespins' ? 'Buffalo Buy FS' : buyMode === 'bonus' ? 'Buffalo Buy Coins' : 'Buffalo Spin';
  if (round.baseBonus) tier += ' + Hold&Win';
  if (round.freeSpins && !buyMode) tier += ` + ${round.freeSpins.initialSpins}FS`;
  if (isWin) tier += ` x${multiplier}`;

  return {
    betAmount: bet,
    totalCost,
    totalPayout,
    rawPayout,
    capped,
    multiplier,
    isWin,
    bonusBuy: buyMode,
    tier,
    roll: round.baseEval.lineWins.length,
    outcome: {
      baseGrid: round.baseGrid,
      baseEval: round.baseEval,
      baseBonus: round.baseBonus,
      freeSpins: round.freeSpins,
      totalPayout,
      capped
    }
  };
}

module.exports = {
  ROWS,
  COLS,
  PAYLINES,
  PAYTABLE,
  SCATTER_PAY,
  FREE_SPINS_INIT,
  FREE_SPINS_RETRIGGER,
  JACKPOTS,
  BET_STEPS,
  BASE_CALIBRATED_RTP,
  makeCoinData,
  generateSpinGrid,
  evaluateSpin,
  simulateBonusGame,
  resolveBuffaloSpin
};
