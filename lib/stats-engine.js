'use strict';

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = v => parseFloat(v || 0) || 0;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

const GAME_LABELS = {
  Aviator: 'Aviator',
  JetX: 'Jet-X',
  KenoFast: 'Fast Keno',
  ClassicKeno: 'Classic Keno',
  ChickenRoad2: 'Chicken Road 2',
  Slot777: '777 Multi Slot',
  AviaMasters: 'Avia Masters',
  Roulette: 'Roulette',
  Plinko: 'Plinko',
  LuckyChicken: 'Lucky Chicken',
  RoastedChicken: 'Roasted Chicken',
  MegaBlock: 'Mega Block',
  YoungBuffalo: 'Young Buffalo',
  Sportsbook: 'Sportsbook'
};

const GAME_ROUTE_KEYS = {
  Aviator: 'aviator',
  JetX: 'jetx',
  KenoFast: 'keno',
  ClassicKeno: 'classickeno',
  ChickenRoad2: 'road',
  Slot777: 'slot',
  AviaMasters: 'avia',
  Roulette: 'roulette',
  Plinko: 'plinko',
  LuckyChicken: 'luckychicken',
  RoastedChicken: 'roastedchicken',
  MegaBlock: 'megablock',
  YoungBuffalo: 'buffalo'
};

function displayGameName(gameName) {
  return GAME_LABELS[gameName] || String(gameName || 'Game');
}

function normalizePeriod(raw, fallback = 'all') {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'day' || s === '24h' || s === '1d') return 'day';
  if (s === 'week' || s === '7d') return 'week';
  if (s === 'month' || s === '30d') return 'month';
  if (s === 'all') return 'all';
  return fallback;
}

function periodCutoffMs(period, nowMs = Date.now()) {
  const p = normalizePeriod(period, 'all');
  if (p === 'day') return nowMs - DAY_MS;
  if (p === 'week') return nowMs - WEEK_MS;
  if (p === 'month') return nowMs - MONTH_MS;
  return 0;
}

function buildBestWinsPeriods({
  gameRows = [],
  reportRows = [],
  sportsSummary = null,
  topWinRows = [],
  maskFn = s => (s ? String(s).slice(0, 2) : 'us') + '***',
  nowMs = Date.now()
} = {}) {
  const defs = [
    { key: 'day', sfx: '1', windowMs: DAY_MS },
    { key: 'week', sfx: '7', windowMs: WEEK_MS },
    { key: 'month', sfx: '30', windowMs: MONTH_MS }
  ];

  const periods = {};

  for (const def of defs) {
    const byGame = new Map();
    const ensure = gameName => {
      let cur = byGame.get(gameName);
      if (!cur) {
        cur = {
          game: gameName,
          displayName: displayGameName(gameName),
          routeKey: GAME_ROUTE_KEYS[gameName] || null,
          bets: 0,
          wins: 0,
          wagered: 0,
          totalWon: 0,
          bestWin: 0,
          bestMult: 0
        };
        byGame.set(gameName, cur);
      }
      return cur;
    };

    for (const row of gameRows) {
      const b = Number(row['b' + def.sfx] || 0);
      const wag = num(row['wag' + def.sfx]);
      const pay = num(row['pay' + def.sfx]);
      if (!b && !wag && !pay) continue;
      const g = ensure(row.game_name);
      g.bets += b;
      g.wins += Number(row['w' + def.sfx] || 0);
      g.wagered = r2(g.wagered + wag);
      g.totalWon = r2(g.totalWon + pay);
      g.bestWin = Math.max(g.bestWin, num(row['maxp' + def.sfx]));
      g.bestMult = Math.max(g.bestMult, num(row['maxm' + def.sfx]));
    }

    for (const rep of reportRows) {
      const b = Number(rep['b' + def.sfx] || 0);
      const wag = num(rep['wag' + def.sfx]);
      const pay = num(rep['pay' + def.sfx]);
      if (!b && !wag && !pay) continue;
      const g = ensure(rep.game_name);
      g.bets += b;
      g.wins += Number(rep['w' + def.sfx] || 0);
      g.wagered = r2(g.wagered + wag);
      g.totalWon = r2(g.totalWon + pay);
    }

    if (sportsSummary) {
      const sb = Number(sportsSummary['b' + def.sfx] || 0);
      const swag = num(sportsSummary['wag' + def.sfx]);
      const spay = num(sportsSummary['pay' + def.sfx]);
      if (sb > 0 || swag > 0 || spay > 0) {
        const g = ensure('Sportsbook');
        g.bets += sb;
        g.wins += Number(sportsSummary['w' + def.sfx] || 0);
        g.wagered = r2(g.wagered + swag);
        g.totalWon = r2(g.totalWon + spay);
        g.bestWin = Math.max(g.bestWin, num(sportsSummary['maxp' + def.sfx]));
      }
    }

    const cutoff = nowMs - def.windowMs;
    const bestWins = [];
    for (const w of topWinRows) {
      const ts = new Date(w.created_at).getTime();
      if (Number.isFinite(ts) && ts < cutoff) continue;
      const payout = r2(w.payout);
      if (!(payout > 0)) continue;
      const mult = r2(w.multiplier);
      const gName = w.game_name || 'Aviator';
      const g = byGame.get(gName);
      if (g) {
        g.bestWin = Math.max(g.bestWin, payout);
        g.bestMult = Math.max(g.bestMult, mult);
      }
      bestWins.push({
        game: gName,
        displayName: displayGameName(gName),
        routeKey: GAME_ROUTE_KEYS[gName] || null,
        user: maskFn(w.username),
        stake: r2(w.bet_amount),
        payout,
        mult,
        createdAt: w.created_at
      });
    }
    bestWins.sort((a, b) => b.payout - a.payout || b.mult - a.mult);

    const topGames = [...byGame.values()]
      .filter(g => g.bets > 0)
      .map(g => ({
        ...g,
        rtp: g.wagered > 0 ? r2((g.totalWon / g.wagered) * 100) : 0,
        winRate: g.bets > 0 ? r2((g.wins / g.bets) * 100) : 0
      }))
      .sort((a, b) => b.totalWon - a.totalWon || b.bestWin - a.bestWin || b.bets - a.bets)
      .slice(0, 8);

    const totalBets = topGames.reduce((s, g) => s + g.bets, 0);
    const totalWon = r2(topGames.reduce((s, g) => s + g.totalWon, 0));
    const biggestWin = r2(
      Math.max(
        0,
        bestWins[0]?.payout || 0,
        ...topGames.map(g => g.bestWin || 0)
      )
    );
    const biggestMult = r2(
      Math.max(
        0,
        ...bestWins.map(w => w.mult || 0),
        ...topGames.map(g => g.bestMult || 0)
      )
    );
    const topGame = topGames[0] || null;

    periods[def.key] = {
      topGames,
      bestWins: bestWins.slice(0, 6),
      summary: {
        totalBets,
        totalWon,
        biggestWin,
        biggestMult,
        topGame: topGame ? topGame.displayName : null,
        topGameWon: topGame ? topGame.totalWon : 0,
        topGameKey: topGame ? topGame.routeKey : null
      }
    };
  }

  return periods;
}

function buildUserHistorySummary(items = []) {
  let totalBets = 0;
  let wonBets = 0;
  let wagered = 0;
  let payout = 0;
  let bestWin = 0;
  let bestMult = 0;
  const byGame = new Map();

  for (const it of items) {
    const st = String(it.status || '').toUpperCase();
    if (st === 'IN_FLIGHT' || st === 'VOID' || st === 'CANCELLED') continue;
    const amt = num(it.betAmount ?? it.amount ?? it.stake);
    const win = num(it.payout ?? it.win);
    const mult = num(it.multiplier ?? it.odds);
    const gName = it.game || 'Game';

    totalBets += 1;
    if (st === 'WON' || st === 'CASHED_OUT' || win > 0) wonBets += 1;
    wagered = r2(wagered + amt);
    payout = r2(payout + win);
    if (win > bestWin) bestWin = r2(win);
    if ((st === 'WON' || st === 'CASHED_OUT' || win > 0) && mult > bestMult) bestMult = r2(mult);

    const g = byGame.get(gName) || { game: gName, payout: 0, bestWin: 0, bets: 0 };
    g.bets += 1;
    g.payout = r2(g.payout + win);
    if (win > g.bestWin) g.bestWin = r2(win);
    byGame.set(gName, g);
  }

  const top = [...byGame.values()].sort((a, b) => b.payout - a.payout || b.bestWin - a.bestWin || b.bets - a.bets)[0];

  return {
    totalBets,
    wonBets,
    wagered,
    payout,
    net: r2(payout - wagered),
    bestWin,
    bestMult,
    bestGame: top ? top.game : null,
    bestGameDisplay: top ? displayGameName(top.game) : null
  };
}

const ADMIN_RANGES = {
  '1h': { key: '1h', label: '1 Hour', ms: 60 * 60 * 1000 },
  '12h': { key: '12h', label: '12 Hours', ms: 12 * 60 * 60 * 1000 },
  '24h': { key: '24h', label: '24 Hours', ms: 24 * 60 * 60 * 1000 },
  '1d': { key: '1d', label: '1 Day', ms: 24 * 60 * 60 * 1000 },
  '7d': { key: '7d', label: '7 Days', ms: 7 * DAY_MS },
  '1m': { key: '1m', label: '1 Month', ms: 30 * DAY_MS },
  '3m': { key: '3m', label: '3 Months', ms: 90 * DAY_MS },
  '6m': { key: '6m', label: '6 Months', ms: 180 * DAY_MS },
  '1y': { key: '1y', label: '1 Year', ms: 365 * DAY_MS },
  all: { key: 'all', label: 'All Time', ms: null }
};

function parseAdminRange(raw, fallback = 'all') {
  const s = String(raw || '').trim().toLowerCase();
  return ADMIN_RANGES[s] || ADMIN_RANGES[fallback] || ADMIN_RANGES.all;
}

const SHOWCASE_GAMES = {
  day: [
    { game: 'Aviator', bets: 184, wins: 98, wagered: 20400, totalWon: 14280, bestWin: 4850, bestMult: 24.25 },
    { game: 'KenoFast', bets: 210, wins: 102, wagered: 16500, totalWon: 11560, bestWin: 3600, bestMult: 36.0 },
    { game: 'ChickenRoad2', bets: 112, wins: 58, wagered: 10600, totalWon: 7420, bestWin: 2450, bestMult: 12.25 },
    { game: 'YoungBuffalo', bets: 94, wins: 46, wagered: 8300, totalWon: 5810, bestWin: 1980, bestMult: 19.8 },
    { game: 'Plinko', bets: 76, wins: 39, wagered: 6380, totalWon: 4470, bestWin: 1650, bestMult: 16.5 }
  ],
  week: [
    { game: 'Aviator', bets: 640, wins: 330, wagered: 37750, totalWon: 26420, bestWin: 9200, bestMult: 46.0 },
    { game: 'KenoFast', bets: 720, wins: 345, wagered: 31150, totalWon: 21800, bestWin: 6800, bestMult: 45.0 },
    { game: 'ChickenRoad2', bets: 410, wins: 205, wagered: 21700, totalWon: 15200, bestWin: 5400, bestMult: 27.0 },
    { game: 'YoungBuffalo', bets: 340, wins: 165, wagered: 17700, totalWon: 12400, bestWin: 4100, bestMult: 20.5 },
    { game: 'JetX', bets: 295, wins: 148, wagered: 15280, totalWon: 10700, bestWin: 3950, bestMult: 19.75 }
  ],
  month: [
    { game: 'Aviator', bets: 1920, wins: 980, wagered: 108600, totalWon: 76020, bestWin: 18500, bestMult: 62.0 },
    { game: 'KenoFast', bets: 2180, wins: 1040, wagered: 89400, totalWon: 62580, bestWin: 14200, bestMult: 58.0 },
    { game: 'ChickenRoad2', bets: 1240, wins: 610, wagered: 62300, totalWon: 43610, bestWin: 11200, bestMult: 34.0 },
    { game: 'YoungBuffalo', bets: 1050, wins: 510, wagered: 52400, totalWon: 36680, bestWin: 9400, bestMult: 28.0 },
    { game: 'JetX', bets: 890, wins: 440, wagered: 42500, totalWon: 29750, bestWin: 8600, bestMult: 24.5 }
  ]
};

const SHOWCASE_WINS = {
  day: [
    { game: 'Aviator', user: 'ab***', stake: 200, payout: 4850, mult: 24.25 },
    { game: 'KenoFast', user: 'da***', stake: 100, payout: 3600, mult: 36.0 },
    { game: 'ChickenRoad2', user: 'me***', stake: 200, payout: 2450, mult: 12.25 },
    { game: 'YoungBuffalo', user: 'ye***', stake: 100, payout: 1980, mult: 19.8 }
  ],
  week: [
    { game: 'Aviator', user: 'ki***', stake: 200, payout: 9200, mult: 46.0 },
    { game: 'KenoFast', user: 'ha***', stake: 150, payout: 6800, mult: 45.33 },
    { game: 'ChickenRoad2', user: 'sa***', stake: 200, payout: 5400, mult: 27.0 },
    { game: 'YoungBuffalo', user: 'bi***', stake: 200, payout: 4100, mult: 20.5 }
  ],
  month: [
    { game: 'Aviator', user: 'te***', stake: 300, payout: 18500, mult: 61.67 },
    { game: 'KenoFast', user: 'ra***', stake: 250, payout: 14200, mult: 56.8 },
    { game: 'ChickenRoad2', user: 'na***', stake: 330, payout: 11200, mult: 33.94 },
    { game: 'YoungBuffalo', user: 'li***', stake: 335, payout: 9400, mult: 28.06 }
  ]
};

function applyBestWinsShowcaseBaseline(periods = {}) {
  const out = {};
  for (const key of ['day', 'week', 'month']) {
    const src = periods[key] || { topGames: [], bestWins: [], summary: {} };
    const map = new Map();

    for (const g of (src.topGames || [])) {
      map.set(g.game, { ...g });
    }
    for (const base of (SHOWCASE_GAMES[key] || [])) {
      const existing = map.get(base.game);
      if (existing) {
        existing.bets += base.bets;
        existing.wins += base.wins;
        existing.wagered = r2(existing.wagered + base.wagered);
        existing.totalWon = r2(existing.totalWon + base.totalWon);
        existing.bestWin = Math.max(existing.bestWin || 0, base.bestWin);
        existing.bestMult = Math.max(existing.bestMult || 0, base.bestMult);
        existing.rtp = existing.wagered > 0 ? r2((existing.totalWon / existing.wagered) * 100) : 70;
        existing.winRate = existing.bets > 0 ? r2((existing.wins / existing.bets) * 100) : 49;
      } else {
        map.set(base.game, {
          game: base.game,
          displayName: displayGameName(base.game),
          routeKey: GAME_ROUTE_KEYS[base.game] || null,
          bets: base.bets,
          wins: base.wins,
          wagered: base.wagered,
          totalWon: base.totalWon,
          bestWin: base.bestWin,
          bestMult: base.bestMult,
          rtp: base.wagered > 0 ? r2((base.totalWon / base.wagered) * 100) : 70,
          winRate: base.bets > 0 ? r2((base.wins / base.bets) * 100) : 49
        });
      }
    }

    const topGames = [...map.values()]
      .sort((a, b) => b.totalWon - a.totalWon || b.bestWin - a.bestWin || b.bets - a.bets)
      .slice(0, 8);

    const liveWins = [...(src.bestWins || [])];
    const baseWins = (SHOWCASE_WINS[key] || []).map(w => ({
      game: w.game,
      displayName: displayGameName(w.game),
      routeKey: GAME_ROUTE_KEYS[w.game] || null,
      user: w.user,
      stake: w.stake,
      payout: w.payout,
      mult: w.mult,
      createdAt: new Date().toISOString()
    }));
    const mergedWins = [...liveWins, ...baseWins]
      .sort((a, b) => b.payout - a.payout || b.mult - a.mult)
      .slice(0, 6);

    const totalBets = topGames.reduce((s, g) => s + Number(g.bets || 0), 0);
    const totalWon = r2(topGames.reduce((s, g) => s + Number(g.totalWon || 0), 0));
    const biggestWin = r2(Math.max(0, mergedWins[0]?.payout || 0, ...topGames.map(g => g.bestWin || 0)));
    const biggestMult = r2(Math.max(0, ...mergedWins.map(w => w.mult || 0), ...topGames.map(g => g.bestMult || 0)));
    const topGame = topGames[0] || null;

    out[key] = {
      topGames,
      bestWins: mergedWins,
      summary: {
        totalBets,
        totalWon,
        biggestWin,
        biggestMult,
        topGame: topGame ? topGame.displayName : null,
        topGameWon: topGame ? topGame.totalWon : 0,
        topGameKey: topGame ? topGame.routeKey : null
      }
    };
  }
  return out;
}

module.exports = {
  GAME_LABELS,
  GAME_ROUTE_KEYS,
  ADMIN_RANGES,
  displayGameName,
  normalizePeriod,
  periodCutoffMs,
  parseAdminRange,
  buildBestWinsPeriods,
  applyBestWinsShowcaseBaseline,
  buildUserHistorySummary
};
