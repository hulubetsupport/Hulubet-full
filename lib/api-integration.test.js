'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_PORT = 3199;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PIN = 'testpin1234';

test('Full end-to-end API workflow: Bonuses, Keno/Game Server, RTP Settings, Chat & Sportsbook Settlement', async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_URL: '',
      BOT_TOKEN: '',
      ADMIN_PIN: PIN,
      CASHBACK_PERCENT: '10%'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(() => {
    try { child.kill('SIGTERM'); } catch (_) {}
  });

  // Wait for server health check
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/ping`);
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  assert.equal(ready, true, 'Ephemeral test server did not start in time');

  const hU = { 'Content-Type': 'application/json', 'x-telegram-init-data': 'demo_session' };
  const hA = { 'Content-Type': 'application/json', 'x-admin-token': PIN };
  const reqJson = async (p, opts = {}) => {
    const r = await fetch(`${BASE}${p}`, opts);
    return { status: r.status, body: await r.json() };
  };

  // 1. Public config handles '10%' env var safely
  const cfg = await reqJson('/api/public/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.cashbackPercent, 10);
  assert.equal(cfg.body.welcomeBonus, 20);
  assert.equal(cfg.body.referralBonus, 50);

  // 2. User init + Topup
  const init = await reqJson('/api/user/init', { headers: hU });
  assert.equal(init.status, 200);
  assert.equal(init.body.balance, 20);

  const top = await reqJson('/api/admin/topup', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ userId: init.body.userId, amount: 500 })
  });
  assert.equal(top.status, 200);

  // 3. Lucky Spin + 24h cooldown enforcement
  const bStat = await reqJson('/api/bonus/status', { headers: hU });
  assert.equal(bStat.status, 200);
  assert.equal(bStat.body.spin.canSpin, true);
  assert.equal(bStat.body.spin.slices.length, 8);

  const sp1 = await reqJson('/api/bonus/lucky-spin', { method: 'POST', headers: hU, body: '{}' });
  assert.equal(sp1.status, 200);
  assert.equal(sp1.body.success, true);
  assert.ok(sp1.body.sliceIndex >= 0 && sp1.body.sliceIndex < 8);

  const sp2 = await reqJson('/api/bonus/lucky-spin', { method: 'POST', headers: hU, body: '{}' });
  assert.equal(sp2.status, 429);

  // 4. Keno play + /api/user/history returns safe picks/drawnNumbers without leaking crash secrets
  const kPlay = await reqJson('/api/bet/play', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ gameName: 'KenoFast', betAmount: 10, clientData: { picks: [4, 18, 29, 77] } })
  });
  assert.equal(kPlay.status, 200);
  assert.equal(kPlay.body.visualOutcome.drawnNumbers.length, 20);

  const hist = await reqJson('/api/user/history', { headers: hU });
  assert.equal(hist.status, 200);
  const kRow = hist.body.history.find(h => h.game === 'KenoFast');
  assert.ok(kRow);
  assert.deepEqual(kRow.picks, [4, 18, 29, 77]);
  assert.equal(kRow.drawnNumbers.length, 20);

  // 5. Promo create -> toggle off (reject) -> toggle on -> redeem
  const cp = await reqJson('/api/admin/create-promo', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ code: 'VIP25', bonusAmount: 25, maxUses: 10 })
  });
  assert.equal(cp.status, 200);

  const tg1 = await reqJson('/api/admin/toggle-promo', { method: 'POST', headers: hA, body: JSON.stringify({ code: 'VIP25' }) });
  assert.equal(tg1.body.isActive, false);

  const prFail = await reqJson('/api/promo/redeem', { method: 'POST', headers: hU, body: JSON.stringify({ code: 'VIP25' }) });
  assert.equal(prFail.status, 404);

  const tg2 = await reqJson('/api/admin/toggle-promo', { method: 'POST', headers: hA, body: JSON.stringify({ code: 'VIP25' }) });
  assert.equal(tg2.body.isActive, true);

  const prOk = await reqJson('/api/promo/redeem', { method: 'POST', headers: hU, body: JSON.stringify({ code: 'VIP25' }) });
  assert.equal(prOk.status, 200);
  assert.equal(prOk.body.awarded, 25);

  // 6. Sportsbook create/bet/cashout/settle FT credit
  const mNew = await reqJson('/api/admin/sports/create', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ sport: 'Soccer', league: 'EPL', home: 'Saint George', away: 'Fasil Kenema' })
  });
  assert.equal(mNew.status, 200);
  const match = mNew.body.match;
  assert.equal(match.markets.length, 5); // 1, X, 2, O2.5, U2.5

  const sBetWin = await reqJson('/api/sports/bet', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ matchId: match.id, market: match.markets[0].label, stake: 50 })
  });
  assert.equal(sBetWin.status, 200);

  const sBetCash = await reqJson('/api/sports/bet', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ matchId: match.id, market: match.markets[1].label, stake: 30 })
  });
  assert.equal(sBetCash.status, 200);

  const cashOut = await reqJson('/api/sports/cashout', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ ticketId: sBetCash.body.ticket.id })
  });
  assert.equal(cashOut.status, 200);
  assert.ok(cashOut.body.payout > 0);
  const balBeforeSettle = cashOut.body.newBalance;

  const settle = await reqJson('/api/admin/sports/settle', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ matchId: match.id, homeScore: 3, awayScore: 1 })
  });
  assert.equal(settle.status, 200);
  assert.equal(settle.body.wonCount, 1);
  assert.equal(settle.body.settledCount, 1);
  assert.ok(settle.body.totalPayout > 50);

  const initAfter = await reqJson('/api/user/init', { headers: hU });
  assert.ok(Math.abs(initAfter.body.balance - (balBeforeSettle + settle.body.totalPayout)) < 0.02);

  // 7. Admin RTP & Bonus settings + cumulative gameStats
  const upSet = await reqJson('/api/admin/update-settings', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ targetRtp: 0.88, kenoRtp: 0.74, agentCommission: 0.03, welcomeBonus: 30, referralBonus: 75, cashbackPercent: 15 })
  });
  assert.equal(upSet.status, 200);

  const dash = await reqJson('/api/admin/master-dashboard', { headers: hA });
  assert.equal(dash.status, 200);
  assert.equal(dash.body.settings.kenoRtp, 74);
  assert.equal(dash.body.settings.welcomeBonus, 30);
  assert.equal(dash.body.settings.referralBonus, 75);
  assert.equal(dash.body.settings.cashbackPercent, 15);
  const spStat = dash.body.gameStats.find(g => g.game === 'Sportsbook');
  assert.ok(spStat && spStat.bets >= 2 && spStat.targetRtp === 92);

  // 8. Chat send & read
  const cSend = await reqJson('/api/chat/send', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ message: 'Selam <img src=x onerror=alert(1)>' })
  });
  assert.equal(cSend.status, 200);
  const cList = await reqJson('/api/chat/messages');
  assert.equal(cList.status, 200);
  assert.ok(cList.body.messages.some(m => m.id === cSend.body.msg.id));

  // 9. Admin dashboard cache immediately reflects mutations without waiting TTL
  const top2 = await reqJson('/api/admin/topup', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ userId: init.body.userId, amount: 100 })
  });
  assert.equal(top2.status, 200);
  const dash2 = await reqJson('/api/admin/master-dashboard', { headers: hA });
  assert.equal(dash2.status, 200);
  const uAfter = dash2.body.users.find(u => u.id === init.body.userId);
  assert.ok(uAfter && uAfter.balance > dash.body.users.find(u => u.id === init.body.userId).balance);
});
