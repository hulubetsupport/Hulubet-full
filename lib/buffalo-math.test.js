'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const buffalo = require('./buffalo-math');
const statsEngine = require('./stats-engine');

test('evaluateSpin sums Wild x2 + x3 multipliers along matching paylines', () => {
  const grid = Array.from({ length: buffalo.COLS }, () =>
    Array.from({ length: buffalo.ROWS }, () => ({ id: '10', mult: 0 }))
  );
  // Make row 0 all non-matching except row 1: buffalo - wild(x2) - wild(x3) - buffalo - J
  for (let c = 0; c < buffalo.COLS; c++) {
    for (let r = 0; r < buffalo.ROWS; r++) {
      grid[c][r] = { id: (c + r) % 2 === 0 ? 'Q' : 'J', mult: 0 };
    }
  }
  grid[0][1] = { id: 'buffalo', mult: 0 };
  grid[1][1] = { id: 'wild', mult: 2 };
  grid[2][1] = { id: 'wild', mult: 3 };
  grid[3][1] = { id: 'buffalo', mult: 0 };

  const res = buffalo.evaluateSpin(grid, 10);
  const line2 = res.lineWins.find(w => w.lineNumber === 2);
  assert.ok(line2, 'Payline 2 should match 4 Buffalos with summed Wilds');
  assert.equal(line2.count, 4);
  assert.equal(line2.mult, 5); // 2 + 3 summed
  // 4x buffalo base pay = 10, * 5 wild sum * 10 ETB = 500 ETB
  assert.equal(line2.amount, 500);
});

test('evaluateSpin scores Scatters anywhere and rejects invalid low wagers', () => {
  const grid = Array.from({ length: buffalo.COLS }, () =>
    Array.from({ length: buffalo.ROWS }, () => ({ id: '10', mult: 0 }))
  );
  grid[0][0] = { id: 'scatter', mult: 0 };
  grid[2][3] = { id: 'scatter', mult: 0 };
  grid[4][1] = { id: 'scatter', mult: 0 };

  const res = buffalo.evaluateSpin(grid, 10);
  assert.equal(res.scatterCount, 3);
  assert.equal(res.scatterWin, 10); // 3 scatters = 1x bet

  assert.throws(() => buffalo.resolveBuffaloSpin({ wager: 1 }), /Minimum bet is 2 ETB/);
});

test('Bonus Buy costs, Free Spins trigger, Bonus Game trigger, and maxPayout cap work accurately', () => {
  const fsBuy = buffalo.resolveBuffaloSpin({ wager: 5, rtp: 0.70, maxPayout: 20000, bonusBuy: 'freespins' });
  assert.equal(fsBuy.totalCost, 500);
  assert.ok(fsBuy.outcome.freeSpins, 'Bonus Buy Free Spins must include freeSpins sequence');
  assert.ok(fsBuy.outcome.freeSpins.initialSpins >= 8);
  assert.ok(fsBuy.totalPayout <= 20000);

  const bgBuy = buffalo.resolveBuffaloSpin({ wager: 5, rtp: 0.70, maxPayout: 20000, bonusBuy: 'bonus' });
  assert.equal(bgBuy.totalCost, 400);
  assert.ok(bgBuy.outcome.baseBonus, 'Bonus Buy Coins must include Hold & Win baseBonus sequence');
  assert.ok(bgBuy.outcome.baseBonus.lockedCount >= 8);
  assert.ok(bgBuy.totalPayout <= 20000);

  // Strict maxPayout cap check
  const cappedCheck = buffalo.resolveBuffaloSpin({ wager: 1000, rtp: 0.70, maxPayout: 50, bonusBuy: 'bonus' });
  assert.ok(cappedCheck.totalPayout <= 50);
  assert.equal(cappedCheck.capped, cappedCheck.rawPayout > 50);
});

test('Young Buffalo empirical RTP converges near 70% across Main Spins and Bonus Buys', () => {
  const mainSpins = 60000;
  let mainPaid = 0;
  for (let i = 0; i < mainSpins; i++) {
    mainPaid += buffalo.resolveBuffaloSpin({ wager: 10, rtp: 0.70, maxPayout: 1000000 }).totalPayout;
  }
  const mainRtp = mainPaid / (mainSpins * 10);
  assert.ok(mainRtp >= 0.58 && mainRtp <= 0.82, `Expected main RTP ~0.70, got ${(mainRtp * 100).toFixed(2)}%`);

  const buyCount = 5000;
  let fsPaid = 0;
  let bgPaid = 0;
  for (let i = 0; i < buyCount; i++) {
    fsPaid += buffalo.resolveBuffaloSpin({ wager: 10, rtp: 0.70, maxPayout: 1000000, bonusBuy: 'freespins' }).totalPayout;
    bgPaid += buffalo.resolveBuffaloSpin({ wager: 10, rtp: 0.70, maxPayout: 1000000, bonusBuy: 'bonus' }).totalPayout;
  }
  const fsRtp = fsPaid / (buyCount * 1000);
  const bgRtp = bgPaid / (buyCount * 800);
  assert.ok(fsRtp >= 0.60 && fsRtp <= 0.82, `Expected Buy FS RTP ~0.70, got ${(fsRtp * 100).toFixed(2)}%`);
  assert.ok(bgRtp >= 0.60 && bgRtp <= 0.82, `Expected Buy Coins RTP ~0.70, got ${(bgRtp * 100).toFixed(2)}%`);
});

const { spawn } = require('node:child_process');
const path = require('node:path');

test('stats-engine maps YoungBuffalo label and route key', () => {
  assert.equal(statsEngine.displayGameName('YoungBuffalo'), 'Young Buffalo');
  assert.equal(statsEngine.GAME_ROUTE_KEYS.YoungBuffalo, 'buffalo');
});

test('HTTP integration: /Buffalo/, /api/games/buffalo/config (70% RTP), /play, and admin stats work end-to-end', async (t) => {
  const port = 3196;
  const base = `http://127.0.0.1:${port}`;
  const pin = 'buffalopin99';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: '', BOT_TOKEN: '', ADMIN_PIN: pin },
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

  const htmlRes = await fetch(`${base}/Buffalo/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.ok(html.includes('Young Buffalo Song') && html.includes('/game-bridge.js'));

  const cfg = await (await fetch(`${base}/api/games/buffalo/config`)).json();
  assert.equal(cfg.success, true);
  assert.equal(cfg.rtp, 70);
  assert.equal(cfg.minBet, 2);

  const hU = { 'Content-Type': 'application/json', 'x-telegram-init-data': 'demo_session' };
  const hA = { 'Content-Type': 'application/json', 'x-admin-token': pin };

  const init = await (await fetch(`${base}/api/user/init`, { headers: hU })).json();
  assert.equal(init.success, true);

  const playRes = await (await fetch(`${base}/api/games/buffalo/play`, {
    method: 'POST',
    headers: hU,
    body: JSON.stringify({ betAmount: 2 })
  })).json();
  assert.equal(playRes.success, true);
  assert.equal(playRes.game, 'YoungBuffalo');
  assert.equal(playRes.totalCost, 2);
  assert.equal(playRes.newBalance, Math.round((init.balance - 2 + playRes.payout) * 100) / 100);
  assert.ok(Array.isArray(playRes.outcome.baseGrid) && playRes.outcome.baseGrid.length === 5);

  const dash = await (await fetch(`${base}/api/admin/master-dashboard`, { headers: hA })).json();
  assert.equal(dash.success, true);
  assert.equal(dash.settings.buffaloRtp, 70);
  const buffStat = dash.gameStats.find(g => g.game === 'YoungBuffalo');
  assert.ok(buffStat, 'YoungBuffalo should appear in admin gameStats');
  assert.equal(buffStat.targetRtp, 70);
});
