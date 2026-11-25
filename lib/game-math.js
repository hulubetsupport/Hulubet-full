'use strict';
const crypto = require('crypto');

const r2 = n => Math.round(Number(n) * 100) / 100;
const num = v => parseFloat(v || 0) || 0;

class Bad extends Error {}

const rint = n => crypto.randomInt(0, n);
const pick = (pairs) => {
  let t = 0;
  for (const [, w] of pairs) t += w;
  let x = crypto.randomInt(0, 1e6) / 1e6 * t;
  for (const [v, w] of pairs) {
    if (x < w) return v;
    x -= w;
  }
  return pairs[pairs.length - 1][0];
};

const C = (n, k) => {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return r;
};

// ---- Crash math (Aviator / JetX) ----
const CRASH_A = 0.065, CRASH_B = 0.035, CRASH_C = 1.48, GRACE = 0.3;
const growth = t => Math.floor((1 + CRASH_A * t + CRASH_B * Math.pow(t, CRASH_C)) * 100) / 100;

function crashPointFromSeed(seed, roundId, rtp, maxMult) {
  const h = crypto.createHmac('sha256', seed).update(roundId).digest('hex');
  const u = parseInt(h.slice(0, 13), 16) / Math.pow(2, 52);
  const cp = Math.floor((rtp / (1 - u)) * 100) / 100;
  return Math.min(maxMult, Math.max(1.0, cp));
}

function decideCrash({ cp, auto, el, cashout, clientMult }) {
  const mSrv = growth(el), mChk = growth(Math.max(0, el - GRACE));
  const autoOk = auto && auto < cp;
  if (cashout) {
    let claim = Math.floor(Math.min(Number(clientMult) || 0, mSrv) * 100) / 100;
    if (autoOk && claim > auto) claim = auto;
    if (claim < 1.01) return { state: 'EARLY' };
    return claim < cp ? { state: 'WON', mult: claim } : { state: 'CRASHED' };
  }
  if (autoOk && mSrv >= auto) return { state: 'WON', mult: auto };
  if (mChk >= cp) return { state: 'CRASHED' };
  return { state: 'FLYING' };
}

// ---- Keno (Fast Keno & Classic Keno): 20 of 80 hypergeometric draw ----
const KENO_PAYTABLE = {
  1: [0, 3.5],
  2: [0, 1, 10],
  3: [0, 0, 2.5, 35],
  4: [0, 0, 1, 6, 100],
  5: [0, 0, 1, 3, 20, 250],
  6: [0, 0, 0, 2, 15, 60, 500],
  7: [0, 0, 0, 2, 8, 35, 180, 1000],
  8: [0, 0, 0, 1, 5, 25, 100, 400, 2000],
  9: [0, 0, 0, 1, 4, 15, 60, 250, 1000, 3000],
  10: [0, 0, 0, 1, 2, 10, 40, 150, 500, 1500, 5000]
};
function kenoTable(k) {
  const t = KENO_PAYTABLE[k];
  return t ? t.slice() : new Array(k + 1).fill(0);
}

function kenoDraw() {
  const a = Array.from({ length: 80 }, (_, i) => i + 1);
  for (let i = 79; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, 20);
}

function kenoRound(picks, rtp) {
  const drawn = kenoDraw(), hits = picks.filter(n => drawn.includes(n)).length;
  return { drawn, hits, multiplier: kenoTable(picks.length, rtp)[hits] || 0 };
}

// ---- Slot 777 ----
const SLOT = {
  ids: ['77', 'DOLLAR', 'BELL', 'MELON', 'MANY_GRAPES', 'PLUM', 'LEMON', 'ORANGE', 'CHERRY'],
  w: [1, 2, 3, 4, 4, 6, 7, 7, 8],
  triple: [30, 20, 12, 8, 8, 5, 5, 5, 5],
  pair: [3, 2.5, 2, 1.5, 1.5, 1, 1, 1, 1],
  col: [[1, 0.85], [3, 0.10], [5, 0.05]]
};
const slotMemo = new Map();
function slotTable(rtp) {
  if (slotMemo.has(rtp)) return slotMemo.get(rtp);
  const tw = SLOT.w.reduce((a, b) => a + b, 0), p = SLOT.w.map(x => x / tw);
  let base = 0, hit = 0;
  for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) for (let c = 0; c < 9; c++) {
    const pr = p[a] * p[b] * p[c];
    let m = 0;
    if (a === b && b === c) m = SLOT.triple[a];
    else if (a === b || a === c) m = SLOT.pair[a];
    else if (b === c) m = SLOT.pair[b];
    base += pr * m;
    if (m > 0) hit += pr;
  }
  const ecol = SLOT.col.reduce((a, [m, q]) => a + m * q, 0), f = rtp / (base * ecol);
  const t = { f, hit, triple: SLOT.triple.map(x => r2(x * f)), pair: SLOT.pair.map(x => r2(x * f)) };
  slotMemo.set(rtp, t);
  return t;
}

function slotSpin(rtp) {
  const t = slotTable(rtp), idx = [0, 1, 2].map(() => pick(SLOT.w.map((w, i) => [i, w])));
  const colMult = pick(SLOT.col.map(([m, q]) => [m, q]));
  const [a, b, c] = idx;
  let winType = 'NONE', winReels = [], m = 0;
  if (a === b && b === c) { winType = 'TRIPLE'; winReels = [0, 1, 2]; m = t.triple[a]; }
  else if (a === b) { winType = 'PAIR'; winReels = [0, 1]; m = t.pair[a]; }
  else if (b === c) { winType = 'PAIR'; winReels = [1, 2]; m = t.pair[b]; }
  else if (a === c) { winType = 'PAIR'; winReels = [0, 2]; m = t.pair[a]; }
  return { reels: idx.map(i => SLOT.ids[i]), colMult, winType, winReels, mult: m > 0 ? r2(m * colMult) : 0 };
}

// ---- Plinko X ----
const PL_SHAPE = {
  low: [20, 10, 5, 2, 1.5, 1.3, 1.1, 0.8, 0.5, 0.8, 1.1, 1.3, 1.5, 2, 5, 10, 20],
  medium: [100, 25, 10, 5, 2, 1.4, 0.6, 0.4, 0.2, 0.4, 0.6, 1.4, 2, 5, 10, 25, 100],
  high: [1000, 130, 26, 9, 4, 2, 0.2, 0.1, 0, 0.1, 0.2, 2, 4, 9, 26, 130, 1000]
};
const PL_BALLS = [1, 5, 10, 25];
const plMemo = new Map();
function plinkoTable(risk, rtp) {
  const key = risk + ':' + rtp;
  if (plMemo.has(key)) return plMemo.get(key);
  const s = PL_SHAPE[risk], pr = s.map((_, i) => C(16, i) / 65536), r0 = s.reduce((a, m, i) => a + m * pr[i], 0), f = rtp / r0;
  const t = s.map(m => r2(m * f));
  plMemo.set(key, t);
  return t;
}

function plinkoBall() {
  const path = [];
  let b = 0;
  for (let i = 0; i < 16; i++) {
    const d = rint(2);
    path.push(d);
    b += d;
  }
  return { path, bucket: b };
}

function plinkoPlay(wager, cd, rtp) {
  const risk = String(cd.risk || '');
  if (!PL_SHAPE[risk]) throw new Bad('Invalid risk level');
  const n = Number(cd.ballCount);
  if (!PL_BALLS.includes(n)) throw new Bad('Invalid ball count');
  const unit = r2(wager / n);
  if (Math.abs(unit * n - wager) > 0.011 || unit < 1) throw new Bad('Each ball must be at least 1 ETB');
  const table = plinkoTable(risk, rtp);
  let payout = 0;
  const balls = [];
  for (let i = 0; i < n; i++) {
    const b = plinkoBall(), mult = table[b.bucket], pay = r2(unit * mult);
    payout += pay;
    balls.push({ path: b.path, bucket: b.bucket, mult, payout: pay });
  }
  return { payout: r2(payout), visual: { rows: 16, risk, unitBet: unit, balls }, tier: `Plinko ${risk} x${n}`, roll: balls[0].bucket };
}

// ---- Roulette ----
const ROUL_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const rouletteColor = n => n === 0 ? 'green' : (ROUL_RED.has(n) ? 'red' : 'black');
const rouletteValid = t => /^num-(?:[0-9]|[12][0-9]|3[0-6])$/.test(t) || /^col-[123]$/.test(t) || /^dozen-[123]$/.test(t) || ['low', 'high', 'even', 'odd', 'red', 'black'].includes(t);

function rouletteReturn(t, n) {
  if (t.startsWith('num-')) return n === Number(t.slice(4)) ? 36 : 0;
  if (n === 0) return 0;
  if (t.startsWith('col-')) return (n % 3 || 3) === Number(t.slice(4)) ? 3 : 0;
  if (t.startsWith('dozen-')) return Math.ceil(n / 12) === Number(t.slice(6)) ? 3 : 0;
  if (t === 'low') return n <= 18 ? 2 : 0;
  if (t === 'high') return n >= 19 ? 2 : 0;
  if (t === 'even') return n % 2 === 0 ? 2 : 0;
  if (t === 'odd') return n % 2 === 1 ? 2 : 0;
  if (t === 'red') return ROUL_RED.has(n) ? 2 : 0;
  return !ROUL_RED.has(n) ? 2 : 0;
}

function roulettePlay(wager, cd, maxPayout) {
  const bets = cd.bets;
  if (!Array.isArray(bets) || !bets.length || bets.length > 80) throw new Bad('Place at least one bet');
  const norm = new Map();
  let total = 0;
  for (const b of bets) {
    const amt = r2(b && b.amount);
    if (!b || !rouletteValid(String(b.type)) || !(amt >= 1)) throw new Bad('Invalid roulette bet');
    norm.set(b.type, r2((norm.get(b.type) || 0) + amt));
    total = r2(total + amt);
  }
  if (Math.abs(total - wager) > 0.001) throw new Bad('Bet total does not match the chips on the table');
  let worst = 0;
  for (let n = 0; n <= 36; n++) {
    let ret = 0;
    norm.forEach((a, t) => { ret += a * rouletteReturn(t, n); });
    worst = Math.max(worst, ret);
  }
  if (worst > maxPayout) throw new Bad(`Maximum payout per spin is ${maxPayout} ETB. Reduce your straight-up bets.`);
  const n = rint(37), parts = [];
  let payout = 0;
  norm.forEach((a, t) => {
    const ret = r2(a * rouletteReturn(t, n));
    payout += ret;
    parts.push({ type: t, amount: a, payout: ret });
  });
  return { payout: r2(payout), visual: { winningNumber: n, number: n, color: rouletteColor(n), parts }, tier: `Roulette ${n}`, roll: n };
}

// ---- Avia Masters ----
const AV = { types: [['number', .50], ['mult', .15], ['rocket', .35]], nums: [[1, .5], [2, .3], [5, .15], [10, .05]], mults: [[2, .6], [3, .3], [4, .08], [5, .02]], n: 6, cap: 100 };
const aviaStep = (v, it) => it.type === 'number' ? v + it.val * 0.2 : it.type === 'mult' ? v * it.val : Math.max(0.1, v / 2);
let aviaEMemo = null;
function aviaE() {
  if (aviaEMemo !== null) return aviaEMemo;
  const d = [];
  for (const [t, pt] of AV.types) {
    if (t === 'number') AV.nums.forEach(([v, w]) => d.push([{ type: t, val: v }, pt * w]));
    else if (t === 'mult') AV.mults.forEach(([v, w]) => d.push([{ type: t, val: v }, pt * w]));
    else d.push([{ type: t, val: 2 }, pt]);
  }
  let st = new Map([[1, 1]]);
  for (let i = 0; i < AV.n; i++) {
    const ns = new Map();
    for (const [v, p] of st) for (const [it, q] of d) {
      const nv = Math.round(aviaStep(v, it) * 1e6) / 1e6;
      ns.set(nv, (ns.get(nv) || 0) + p * q);
    }
    st = ns;
  }
  let e = 0;
  for (const [v, p] of st) e += Math.min(v, AV.cap) * p;
  return (aviaEMemo = e);
}

function aviaPlay(wager, rtp) {
  const items = [];
  let v = 1;
  for (let i = 0; i < AV.n; i++) {
    const type = pick(AV.types);
    const val = type === 'number' ? pick(AV.nums) : type === 'mult' ? pick(AV.mults) : 2;
    const it = { type, val };
    items.push(it);
    v = aviaStep(v, it);
  }
  const finalMult = r2(Math.min(v, AV.cap)), pLand = Math.min(1, rtp / aviaE()), landed = crypto.randomInt(0, 1e6) / 1e6 < pLand;
  return { payout: landed ? r2(wager * finalMult) : 0, visual: { safeLanding: landed, landed, targetMultiplier: finalMult, finalMultiplier: finalMult, items }, tier: landed ? 'Avia landed' : 'Avia missed', roll: finalMult };
}

// ---- Lucky Chicken (step-by-step) ----
const CHICKEN = {
  easy: [1.01, 1.04, 1.07, 1.11, 1.16],
  medium: [1.15, 1.35, 1.62, 1.98, 2.45],
  hard: [1.32, 1.85, 2.70, 4.10, 6.50],
  hardcore: [1.68, 2.86, 5.10, 8.28, 14.08]
};
function chickenSurvival(diff, rtp) {
  let m = 1;
  return CHICKEN[diff].map(x => { m = Math.min(m, rtp / x); return m; });
}

// ---- Instant Chicken Road 2 & Roasted Chicken (for Cheknroad.html & rostedchekin.html) ----
const CHICKEN_INSTANT = {
  ChickenRoad2: {
    Easy: [1.01, 1.03, 1.06, 1.10, 1.15, 1.22, 1.30, 1.44, 1.62, 1.90, 2.25, 2.80],
    Medium: [1.05, 1.15, 1.30, 1.55, 1.95, 2.60, 3.60, 5.20, 8.00, 13.0, 22.0, 40.0],
    Hard: [1.18, 1.50, 2.10, 3.20, 5.50, 10.0, 20.0, 45.0, 100.0, 250.0],
    Hardcore: [1.44, 2.21, 3.60, 6.50, 15.0, 40.0, 120.0, 400.0]
  },
  RoastedChicken: {
    Easy: [1.01, 1.04, 1.08, 1.13, 1.20, 1.26, 1.33, 1.42, 1.50, 1.62, 1.78, 2.05],
    Medium: [1.09, 1.25, 1.45, 1.70, 2.05, 2.50, 3.20, 4.30, 6.00, 9.50, 15.0, 25.0],
    Hard: [1.20, 1.55, 2.10, 3.00, 4.60, 7.50, 14.0, 28.0, 60.0, 140.0],
    Extreme: [1.44, 2.30, 4.20, 8.50, 20.0, 55.0, 160.0, 450.0]
  }
};

function normalizeDiffKey(map, raw, fallback) {
  const s = String(raw || '').toLowerCase();
  return Object.keys(map).find(k => k.toLowerCase() === s) || fallback;
}

function survivalCurve(mults, rtp) {
  let m = 1;
  return mults.map(x => { m = Math.min(m, rtp / x); return m; });
}

function chickenInstantPlay(gameName, wager, cd, rtp, maxPayout) {
  const table = CHICKEN_INSTANT[gameName] || CHICKEN_INSTANT.ChickenRoad2;
  const diff = normalizeDiffKey(table, cd.difficulty, 'Easy');
  const mults = table[diff];
  // Pick a target safe step count using weighted buckets scaled to match target RTP
  const maxIdx = Math.min(mults.length - 1, 7);
  const candidates = [0, 1, 2, 3, Math.min(4, maxIdx), Math.min(5, maxIdx)];
  const stepIdx = candidates[rint(candidates.length)];
  const targetMult = mults[stepIdx];
  const winProb = Math.min(0.95, rtp / targetMult);
  const isWin = (crypto.randomInt(0, 1e6) / 1e6) < winProb;
  if (!isWin) {
    const failStep = rint(Math.min(4, mults.length));
    return {
      payout: 0,
      visual: { maxSafeStep: failStep, difficulty: diff },
      tier: `${gameName} ${diff} miss`,
      roll: failStep
    };
  }
  const payout = Math.min(r2(wager * targetMult), maxPayout);
  return {
    payout,
    visual: { maxSafeStep: stepIdx + 1, difficulty: diff, targetMultiplier: targetMult },
    tier: `${gameName} ${diff} x${targetMult}`,
    roll: stepIdx + 1
  };
}

// ---- MegaBlock (Tower Stacker matching megablok.html) ----
const MEGA_LADDERS = {
  EASY: [1.01, 1.04, 1.09, 1.14, 1.20, 1.26, 1.33, 1.41, 1.50, 1.61, 1.73, 1.88, 2.05, 2.25, 2.50, 2.80, 3.18, 3.65, 4.25, 5.05, 6.15, 7.70, 10.00, 15.00],
  MEDIUM: [1.05, 1.12, 1.21, 1.32, 1.45, 1.61, 1.80, 2.05, 2.36, 2.75, 3.25, 3.90, 4.80, 6.00, 7.70, 10.20, 14.00, 20.00, 30.00, 50.00, 90.00, 200.00],
  HARD: [1.15, 1.35, 1.62, 1.98, 2.48, 3.15, 4.10, 5.50, 7.60, 11.00, 16.50, 26.00, 43.00, 75.00, 140.00, 280.00, 600.00, 1400.00, 3500.00, 10000.00],
  HARDCORE: [1.35, 1.90, 2.80, 4.30, 7.00, 12.00, 22.00, 45.00, 100.00, 250.00, 700.00, 2200.00, 7500.00, 25000.00, 100000.00]
};

function megaBlockPlay(wager, cd, rtp, maxPayout) {
  const diff = normalizeDiffKey(MEGA_LADDERS, cd.difficulty, 'EASY');
  const ladder = MEGA_LADDERS[diff];
  const stepIdx = rint(Math.min(6, ladder.length));
  const targetMult = ladder[stepIdx];
  const winProb = Math.min(0.95, rtp / targetMult);
  const isWin = (crypto.randomInt(0, 1e6) / 1e6) < winProb;
  if (!isWin) {
    const maxSafeBlocks = rint(3);
    return {
      payout: 0,
      visual: { maxSafeBlocks, difficulty: diff },
      tier: `MegaBlock ${diff} collapse`,
      roll: maxSafeBlocks
    };
  }
  const payout = Math.min(r2(wager * targetMult), maxPayout);
  return {
    payout,
    visual: { maxSafeBlocks: stepIdx + 1, difficulty: diff, targetMultiplier: targetMult },
    tier: `MegaBlock ${diff} x${targetMult}`,
    roll: stepIdx + 1
  };
}

// ---- Dispatcher for single-request instant games ----
function resolveInstant(game, wager, cd, rtp, maxPayout) {
  if (game === 'KenoFast' || game === 'ClassicKeno') {
    const p = cd.picks;
    if (!Array.isArray(p) || p.length < 1 || p.length > 10) throw new Bad('Pick 1 to 10 numbers');
    const n = p.map(Number), s = new Set(n);
    if (s.size !== n.length || n.some(x => !Number.isInteger(x) || x < 1 || x > 80)) throw new Bad('Invalid number picks');
    const picks = n.sort((a, b) => a - b), k = kenoRound(picks, rtp);
    return { payout: r2(wager * k.multiplier), visual: { drawnNumbers: k.drawn, hits: k.hits, picks }, tier: `${game} ${picks.length} spots, ${k.hits} hits`, roll: k.hits };
  }
  if (game === 'Slot777') {
    const s = slotSpin(rtp);
    return { payout: r2(wager * s.mult), visual: { reels: s.reels, colMult: s.colMult, winType: s.winType, winReels: s.winReels, payline: s.winType }, tier: 'Slot ' + s.winType, roll: s.mult };
  }
  if (game === 'PlinkoX') return plinkoPlay(wager, cd, rtp);
  if (game === 'Roulette') return roulettePlay(wager, cd, maxPayout);
  if (game === 'AviaMasters') return aviaPlay(wager, rtp);
  if (game === 'ChickenRoad2' || game === 'RoastedChicken') return chickenInstantPlay(game, wager, cd, rtp, maxPayout);
  if (game === 'MegaBlock') return megaBlockPlay(wager, cd, rtp, maxPayout);
  throw new Bad('Invalid game');
}

// ---- Addis Ababa time & Cashback schedule ----
function addisParts(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
function cashbackDue(now, lastRun, hour) {
  const a = addisParts(now);
  return a.hour >= hour && a.date !== lastRun ? a.date : null;
}

module.exports = {
  r2, num, Bad, C,
  CRASH_A, CRASH_B, CRASH_C, GRACE, growth, crashPointFromSeed, decideCrash,
  kenoTable, kenoDraw, kenoRound,
  SLOT, slotTable, slotSpin,
  PL_SHAPE, PL_BALLS, plinkoTable, plinkoPlay,
  rouletteColor, rouletteValid, rouletteReturn, roulettePlay,
  AV, aviaStep, aviaE, aviaPlay,
  CHICKEN, chickenSurvival, survivalCurve, normalizeDiffKey,
  CHICKEN_INSTANT, chickenInstantPlay,
  MEGA_LADDERS, megaBlockPlay,
  resolveInstant,
  addisParts, cashbackDue
};
