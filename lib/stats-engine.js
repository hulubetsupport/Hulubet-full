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

module.exports = {
  GAME_LABELS,
  GAME_ROUTE_KEYS,
  displayGameName,
  normalizePeriod,
  periodCutoffMs,
  buildBestWinsPeriods,
  buildUserHistorySummary
};
