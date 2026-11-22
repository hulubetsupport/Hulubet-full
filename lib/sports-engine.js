'use strict';
const crypto = require('crypto');
const { r2, num } = require('./game-math');

const MARGIN_MULTIPLIER = 0.92; // ~8% bookmaker hold

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function buildMarkets(fixture) {
  const hs = Number(fixture.homeScore || 0);
  const as = Number(fixture.awayScore || 0);
  const diff = hs - as;
  const progress = clamp(Number(fixture.progress || 0.25), 0.02, 0.99);

  if (fixture.sport === 'Soccer') {
    // Late-match scores shift outcome probabilities sharply
    const timeWeight = 1 + progress * 2.2;
    let pHome = clamp(0.38 + diff * 0.16 * timeWeight, 0.06, 0.88);
    let pAway = clamp(0.32 - diff * 0.16 * timeWeight, 0.06, 0.88);
    let pDraw = clamp(1 - pHome - pAway, 0.08, 0.55);
    const sum = pHome + pDraw + pAway;
    pHome /= sum; pDraw /= sum; pAway /= sum;

    const totalGoals = hs + as;
    const remShare = 1 - progress;
    const expectedRemGoals = 2.6 * remShare;
    const pOver25 = totalGoals >= 3
      ? 0.96
      : totalGoals === 2
        ? clamp(0.20 + expectedRemGoals * 0.45, 0.12, 0.88)
        : clamp(0.08 + expectedRemGoals * 0.28, 0.05, 0.78);
    const pUnder25 = clamp(1 - pOver25, 0.04, 0.95);

    const toOdd = p => r2(clamp(MARGIN_MULTIPLIER / clamp(p, 0.04, 0.95), 1.05, 18));
    return [
      { key: '1', label: `${fixture.home} Win`, odds: toOdd(pHome) },
      { key: 'X', label: 'Draw', odds: toOdd(pDraw) },
      { key: '2', label: `${fixture.away} Win`, odds: toOdd(pAway) },
      { key: 'O2.5', label: 'Over 2.5 Goals', odds: toOdd(pOver25) },
      { key: 'U2.5', label: 'Under 2.5 Goals', odds: toOdd(pUnder25) }
    ];
  }

  if (fixture.sport === 'Basketball') {
    const scale = 0.04 * (1 + progress * 2.4);
    let pHome = clamp(0.50 + diff * scale, 0.08, 0.90);
    let pAway = clamp(0.50 - diff * scale, 0.08, 0.90);
    let pTie = clamp(0.11 - Math.abs(diff) * 0.008, 0.03, 0.14);
    const sum = pHome + pTie + pAway;
    pHome /= sum; pTie /= sum; pAway /= sum;
    const toOdd = p => r2(clamp(MARGIN_MULTIPLIER / clamp(p, 0.04, 0.94), 1.06, 20));
    return [
      { key: '1', label: `${fixture.home} Win`, odds: toOdd(pHome) },
      { key: 'X', label: 'OT / Tie', odds: toOdd(pTie) },
      { key: '2', label: `${fixture.away} Win`, odds: toOdd(pAway) }
    ];
  }

  // Boxing
  const roundScale = 0.09 * (1 + progress);
  let pHome = clamp(0.50 + diff * roundScale, 0.08, 0.90);
  let pAway = clamp(0.50 - diff * roundScale, 0.08, 0.90);
  const pDraw = 0.06;
  const sum = pHome + pDraw + pAway;
  pHome /= sum; pAway /= sum;
  const toOdd = p => r2(clamp(MARGIN_MULTIPLIER / clamp(p, 0.04, 0.94), 1.06, 22));
  return [
    { key: '1', label: `${fixture.home} Win`, odds: toOdd(pHome) },
    { key: 'X', label: 'Draw', odds: toOdd(pDraw) },
    { key: '2', label: `${fixture.away} Win`, odds: toOdd(pAway) }
  ];
}

function formatClock(fixture) {
  if (fixture.status === 'FT') return 'FT';
  if (fixture.sport === 'Soccer') {
    const min = Math.min(90, Math.max(1, Math.round(fixture.progress * 90)));
    return `LIVE ${min}'`;
  }
  if (fixture.sport === 'Basketball') {
    const q = Math.min(4, Math.max(1, Math.ceil(fixture.progress * 4)));
    return `LIVE Q${q}`;
  }
  const rd = Math.min(12, Math.max(1, Math.ceil(fixture.progress * 12)));
  return `ROUND ${rd}`;
}

function hydrateFixture(raw) {
  const f = { ...raw };
  f.homeScore = Number(f.homeScore || 0);
  f.awayScore = Number(f.awayScore || 0);
  f.progress = clamp(Number(f.progress ?? 0.25), 0.02, 1);
  f.score = `${f.homeScore} - ${f.awayScore}`;
  f.minute = formatClock(f);
  if (!f.customOdds || f.status === 'LIVE') {
    f.markets = buildMarkets(f);
  }
  return f;
}

const MATCH_POOL = [
  { sport: 'Soccer', league: 'UEFA Champions League', home: 'Arsenal FC', away: 'Real Madrid', baseScore: [1, 1] },
  { sport: 'Soccer', league: 'Ethiopia Premier League', home: 'St. George SC', away: 'Ethiopian Coffee', baseScore: [1, 0] },
  { sport: 'Soccer', league: 'English Premier League', home: 'Liverpool', away: 'Man City', baseScore: [0, 1] },
  { sport: 'Soccer', league: 'Ethiopia Premier League', home: 'Fasil Kenema', away: 'Ethiopia Bunna', baseScore: [2, 1] },
  { sport: 'Basketball', league: 'NBA Regular Season', home: 'LA Lakers', away: 'Boston Celtics', baseScore: [64, 61] },
  { sport: 'Basketball', league: 'EuroLeague', home: 'Olympiacos', away: 'Panathinaikos', baseScore: [52, 54] },
  { sport: 'Boxing', league: 'Heavyweight Championship', home: 'Anthony Joshua', away: 'Daniel Dubois', baseScore: [48, 47] },
  { sport: 'Boxing', league: 'Welterweight Bout', home: 'Terence Crawford', away: 'Errol Spence', baseScore: [58, 55] }
];

function createDefaultFixtures(nowMs = Date.now()) {
  const initial = [
    { ...MATCH_POOL[0], id: 'UCL-ARS-RMA', progress: 0.68, homeScore: 2, awayScore: 1, status: 'LIVE', createdAt: nowMs },
    { ...MATCH_POOL[1], id: 'EPL-STG-COF', progress: 0.40, homeScore: 1, awayScore: 0, status: 'LIVE', createdAt: nowMs },
    { ...MATCH_POOL[4], id: 'NBA-LAL-BOS', progress: 0.70, homeScore: 82, awayScore: 79, status: 'LIVE', createdAt: nowMs },
    { ...MATCH_POOL[6], id: 'BOX-HW-TITLE', progress: 0.58, homeScore: 67, awayScore: 66, status: 'LIVE', createdAt: nowMs }
  ];
  return initial.map(hydrateFixture);
}

function createReplacementFixture(sport, seq, nowMs = Date.now()) {
  const candidates = MATCH_POOL.filter(m => m.sport === sport);
  const base = candidates.length ? candidates[seq % candidates.length] : MATCH_POOL[0];
  const prefix = base.sport.slice(0, 3).toUpperCase();
  const id = `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  return hydrateFixture({
    id,
    sport: base.sport,
    league: base.league,
    home: base.home,
    away: base.away,
    homeScore: base.sport === 'Soccer' ? 0 : base.baseScore[0] - 20,
    awayScore: base.sport === 'Soccer' ? 0 : base.baseScore[1] - 20,
    progress: 0.12,
    status: 'LIVE',
    createdAt: nowMs
  });
}

function tickMatch(fixture, randFn) {
  if (fixture.status !== 'LIVE') return fixture;
  const r = typeof randFn === 'function'
    ? () => clamp(Number(randFn()), 0, 0.999999)
    : () => crypto.randomInt(0, 1_000_000) / 1_000_000;

  const f = { ...fixture };
  const step = f.sport === 'Soccer' ? 0.05 : f.sport === 'Basketball' ? 0.06 : 0.08;
  f.progress = clamp(r2(f.progress + step), 0.02, 1);

  if (f.sport === 'Soccer') {
    const roll = r();
    if (roll < 0.07) f.homeScore += 1;
    else if (roll < 0.13) f.awayScore += 1;
  } else if (f.sport === 'Basketball') {
    f.homeScore += Math.floor(r() * 4);
    f.awayScore += Math.floor(r() * 4);
  } else {
    f.homeScore += 9 + (r() < 0.55 ? 1 : 0);
    f.awayScore += 9 + (r() < 0.45 ? 1 : 0);
  }

  if (f.progress >= 1) {
    f.status = 'FT';
    f.finishedAt = Date.now();
  }
  return hydrateFixture(f);
}

function evaluateMarketResult(marketLabel, fixtureOrHomeScore, maybeAwayScore) {
  let homeScore = 0, awayScore = 0, homeName = '', awayName = '';
  if (fixtureOrHomeScore && typeof fixtureOrHomeScore === 'object') {
    homeScore = Number(fixtureOrHomeScore.homeScore || 0);
    awayScore = Number(fixtureOrHomeScore.awayScore || 0);
    homeName = String(fixtureOrHomeScore.home || '').toLowerCase();
    awayName = String(fixtureOrHomeScore.away || '').toLowerCase();
  } else {
    homeScore = Number(fixtureOrHomeScore || 0);
    awayScore = Number(maybeAwayScore || 0);
  }

  const label = String(marketLabel || '').trim();
  const low = label.toLowerCase();
  const total = homeScore + awayScore;

  const overMatch = low.match(/over\s+([0-9]+(?:\.[0-9]+)?)/);
  if (overMatch) return total > parseFloat(overMatch[1]);
  const underMatch = low.match(/under\s+([0-9]+(?:\.[0-9]+)?)/);
  if (underMatch) return total < parseFloat(underMatch[1]);

  if (low === 'x' || low === 'draw' || low.includes('tie')) {
    return homeScore === awayScore;
  }
  if (low === '1' || (homeName && low.includes(homeName))) {
    return homeScore > awayScore;
  }
  if (low === '2' || (awayName && low.includes(awayName))) {
    return awayScore > homeScore;
  }
  return false;
}

function computeCashoutValue(ticket, fixture, margin = 0.90) {
  const stake = num(ticket.stake);
  const potentialWin = num(ticket.potential_win ?? ticket.returnAmt);
  if (!(stake > 0) || !(potentialWin > 0)) return 0;
  if (!fixture || fixture.status !== 'LIVE') return r2(clamp(num(ticket.cashout_value || stake * 0.90), 0, potentialWin * 0.95));

  const label = String(ticket.market || '');
  const low = label.toLowerCase();
  const totalGoals = Number(fixture.homeScore || 0) + Number(fixture.awayScore || 0);

  // Under 2.5 becomes nearly worthless once 3+ goals are scored
  const underMatch = low.match(/under\s+([0-9]+(?:\.[0-9]+)?)/);
  if (underMatch && totalGoals > parseFloat(underMatch[1])) {
    return 0;
  }
  // Over 2.5 becomes near-max payout once 3+ goals are already scored
  const overMatch = low.match(/over\s+([0-9]+(?:\.[0-9]+)?)/);
  if (overMatch && totalGoals > parseFloat(overMatch[1])) {
    return r2(potentialWin * 0.94);
  }

  const mk = (fixture.markets || []).find(
    m => m.label.toLowerCase() === low || m.key.toLowerCase() === low
  );
  if (!mk || !(Number(mk.odds) > 1)) {
    return r2(clamp(stake * 0.90, stake * 0.15, potentialWin * 0.94));
  }

  // Fair win probability extracted from current live market odds (undoing 8% hold)
  const fairProb = clamp((MARGIN_MULTIPLIER / Number(mk.odds)), 0.05, 0.95);
  const rawCash = potentialWin * fairProb * margin;
  return r2(clamp(rawCash, stake * 0.10, potentialWin * 0.94));
}

module.exports = {
  MARGIN_MULTIPLIER,
  createDefaultFixtures,
  createReplacementFixture,
  hydrateFixture,
  buildMarkets,
  tickMatch,
  evaluateMarketResult,
  computeCashoutValue
};
