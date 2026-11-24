'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const {
  normalizePeriod,
  periodCutoffMs,
  buildBestWinsPeriods,
  buildUserHistorySummary
} = require('./stats-engine');

test('normalizePeriod and periodCutoffMs handle day/week/month/all safely', () => {
  const now = 1_750_000_000_000;
  assert.equal(normalizePeriod('DAY'), 'day');
  assert.equal(normalizePeriod('7d'), 'week');
  assert.equal(normalizePeriod('month'), 'month');
  assert.equal(normalizePeriod('unknown', 'all'), 'all');

  assert.equal(periodCutoffMs('day', now), now - 86400e3);
  assert.equal(periodCutoffMs('week', now), now - 7 * 86400e3);
  assert.equal(periodCutoffMs('month', now), now - 30 * 86400e3);
  assert.equal(periodCutoffMs('all', now), 0);
});

test('buildBestWinsPeriods combines live bets, 12h rollups, and sportsbook across day/week/month', () => {
  const now = Date.now();
  const periods = buildBestWinsPeriods({
    nowMs: now,
    gameRows: [
      {
        game_name: 'Aviator',
        b1: 5, w1: 3, wag1: 250, pay1: 420, maxp1: 220, maxm1: 4.4,
        b7: 15, w7: 8, wag7: 900, pay7: 1320, maxp7: 400, maxm7: 8.0,
        b30: 40, w30: 18, wag30: 2500, pay30: 3100, maxp30: 650, maxm30: 13.0
      }
    ],
    reportRows: [
      {
        game_name: 'KenoFast',
        b1: 0, w1: 0, wag1: 0, pay1: 0,
        b7: 30, w7: 12, wag7: 1500, pay7: 1800,
        b30: 90, w30: 35, wag30: 4500, pay30: 5200
      }
    ],
    sportsSummary: {
      b1: 2, w1: 1, wag1: 100, pay1: 185, maxp1: 185,
      b7: 4, w7: 2, wag7: 200, pay7: 310, maxp7: 185,
      b30: 10, w30: 6, wag30: 600, pay30: 920, maxp30: 260
    },
    topWinRows: [
      { username: 'abebe', game_name: 'Aviator', bet_amount: 50, multiplier: 4.4, payout: 220, created_at: new Date(now - 2 * 3600e3) },
      { username: 'meron', game_name: 'Plinko', bet_amount: 100, multiplier: 9.0, payout: 900, created_at: new Date(now - 4 * 86400e3) },
      { username: 'dawit', game_name: 'MegaBlock', bet_amount: 100, multiplier: 15.0, payout: 1500, created_at: new Date(now - 20 * 86400e3) }
    ]
  });

  // Day should only include today's top win (220), not 4d or 20d old wins
  assert.equal(periods.day.topGames[0].game, 'Aviator');
  assert.equal(periods.day.bestWins.length, 1);
  assert.equal(periods.day.bestWins[0].payout, 220);
  assert.equal(periods.day.summary.biggestWin, 220);

  // Week includes archived KenoFast (1800) > Aviator (1320) and 4d Plinko win (900)
  assert.equal(periods.week.topGames[0].game, 'KenoFast');
  assert.equal(periods.week.bestWins.length, 2);
  assert.equal(periods.week.bestWins[0].payout, 900);

  // Month includes all 3 wins (1500 biggest)
  assert.equal(periods.month.topGames[0].game, 'KenoFast');
  assert.equal(periods.month.bestWins.length, 3);
  assert.equal(periods.month.summary.biggestWin, 1500);
});

test('buildUserHistorySummary computes wagered, payout, net, and bestGame', () => {
  const s = buildUserHistorySummary([
    { game: 'Aviator', betAmount: 100, payout: 250, multiplier: 2.5, status: 'WON' },
    { game: 'Aviator', betAmount: 50, payout: 0, multiplier: 0, status: 'LOST' },
    { game: 'KenoFast', betAmount: 40, payout: 120, multiplier: 3.0, status: 'WON' },
    { game: 'Sportsbook', betAmount: 100, payout: 0, multiplier: 2.1, status: 'IN_FLIGHT' }
  ]);
  assert.equal(s.totalBets, 3);
  assert.equal(s.wonBets, 2);
  assert.equal(s.wagered, 190);
  assert.equal(s.payout, 370);
  assert.equal(s.net, 180);
  assert.equal(s.bestWin, 250);
  assert.equal(s.bestGame, 'Aviator');
});

test('HTTP integration: /api/public/best-wins & /api/user/history?period=day work with caching', async (t) => {
  const port = 3207;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: '', BOT_TOKEN: '', ADMIN_PIN: 'testpin1234' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { try { child.kill('SIGTERM'); } catch (_) {} });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/api/ping`);
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  assert.equal(ready, true);

  const headers = { 'Content-Type': 'application/json', 'x-telegram-init-data': 'demo_session' };
  await fetch(`${base}/api/user/init`, { headers });

  const play = await fetch(`${base}/api/bet/play`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ gameName: 'KenoFast', betAmount: 10, clientData: { picks: [5, 12, 23] } })
  }).then(r => r.json());
  assert.equal(play.success, true);

  const histDay = await fetch(`${base}/api/user/history?period=day`, { headers }).then(r => r.json());
  assert.equal(histDay.success, true);
  assert.equal(histDay.period, 'day');
  assert.ok(histDay.summary.totalBets >= 1);
  assert.equal(histDay.summary.wagered, 10);

  const bw1 = await fetch(`${base}/api/public/best-wins`).then(r => r.json());
  assert.equal(bw1.success, true);
  assert.ok(bw1.periods.day && bw1.periods.week && bw1.periods.month);
  assert.ok(bw1.periods.day.topGames.some(g => g.game === 'KenoFast'));

  // Repeat request within TTL serves exact cached payload
  const bw2 = await fetch(`${base}/api/public/best-wins`).then(r => r.json());
  assert.equal(bw2.cachedAt, bw1.cachedAt);
});
