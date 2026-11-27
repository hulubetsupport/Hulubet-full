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

  // 1. Public config handles '10%' env var safely & exposes 50x / 20% first deposit defaults
  const cfg = await reqJson('/api/public/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.cashbackPercent, 10);
  assert.equal(cfg.body.welcomeBonus, 20);
  assert.equal(cfg.body.referralBonus, 10);
  assert.equal(cfg.body.wagerReqMult, 50);
  assert.equal(cfg.body.firstDepBonusMin, 300);
  assert.equal(cfg.body.firstDepBonusPct, 20);

  // 2. User init (20 ETB welcome bonus @ 50x = 1000 wager) + First Deposit 500 ETB (>=300 -> +20% = 100 ETB @ 50x = +5000 wager)
  const init = await reqJson('/api/user/init', { headers: hU });
  assert.equal(init.status, 200);
  assert.equal(init.body.balance, 20);
  assert.equal(init.body.wagerRequirementLeft, 1000);

  const top = await reqJson('/api/admin/topup', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ userId: init.body.userId, amount: 500 })
  });
  assert.equal(top.status, 200);
  assert.equal(top.body.bonusAwarded, 100);
  assert.equal(top.body.newBalance, 620);

  const wdLocked = await reqJson('/api/cashier/withdraw', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ amount: 100, accountNumber: '0911223344', method: 'Telebirr' })
  });
  assert.equal(wdLocked.status, 400);
  assert.match(wdLocked.body.message, /50x wagering/i);

  // 3. Lucky Spin + 24h cooldown enforcement
  const bStat = await reqJson('/api/bonus/status', { headers: hU });
  assert.equal(bStat.status, 200);
  assert.equal(bStat.body.spin.canSpin, true);
  assert.equal(bStat.body.spin.slices.length, 8);
  assert.equal(bStat.body.lockedBonusBalance, 120);
  assert.equal(bStat.body.withdrawableBalance, 500);

  const sp1 = await reqJson('/api/bonus/lucky-spin', { method: 'POST', headers: hU, body: '{}' });
  assert.equal(sp1.status, 200);
  assert.equal(sp1.body.success, true);
  assert.ok(sp1.body.sliceIndex >= 0 && sp1.body.sliceIndex < 8);

  const sp2 = await reqJson('/api/bonus/lucky-spin', { method: 'POST', headers: hU, body: '{}' });
  assert.equal(sp2.status, 429);

  // 4. Synced Keno round endpoints, shared round draw, & /api/user/history?maxAgeHours=12
  const kCur = await reqJson('/api/keno/round/current');
  assert.equal(kCur.status, 200);
  assert.equal(kCur.body.success, true);
  assert.ok(Number.isInteger(kCur.body.roundId));

  const ckCur = await reqJson('/api/classic-keno/round/current');
  assert.equal(ckCur.status, 200);
  assert.equal(ckCur.body.success, true);

  const testRoundId = kCur.body.roundId;
  const kPlay = await reqJson('/api/bet/play', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ gameName: 'KenoFast', betAmount: 10, clientData: { picks: [4, 18, 29, 77], roundId: testRoundId } })
  });
  assert.equal(kPlay.status, 200);
  assert.equal(kPlay.body.visualOutcome.drawnNumbers.length, 20);

  const kPlay2 = await reqJson('/api/bet/play', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ gameName: 'KenoFast', betAmount: 5, clientData: { picks: [1, 2, 3], roundId: testRoundId } })
  });
  assert.equal(kPlay2.status, 200);
  assert.deepEqual(kPlay2.body.visualOutcome.drawnNumbers, kPlay.body.visualOutcome.drawnNumbers);

  if (kCur.body.cycleSec < 79) {
    const histActive = await reqJson('/api/user/history?maxAgeHours=12', { headers: hU });
    assert.equal(histActive.status, 200);
    assert.equal(histActive.body.history.some(h => h.game === 'KenoFast' && Number(h.roundId) === Number(testRoundId)), false);

    const kRes = await reqJson('/api/keno/results');
    assert.equal(kRes.status, 200);
    assert.equal(kRes.body.results.some(r => Number(r.round) === Number(testRoundId)), false);
  }

  const settledRid = testRoundId - 1;
  const kSettled = await reqJson('/api/bet/play', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ gameName: 'KenoFast', betAmount: 5, clientData: { picks: [1, 2, 3], roundId: settledRid } })
  });
  assert.equal(kSettled.status, 200);

  const hist = await reqJson('/api/user/history?maxAgeHours=12', { headers: hU });
  assert.equal(hist.status, 200);
  const kRow = hist.body.history.find(h => h.game === 'KenoFast' && Number(h.roundId) === Number(settledRid));
  assert.ok(kRow);
  assert.deepEqual(kRow.picks, [1, 2, 3]);
  assert.equal(kRow.drawnNumbers.length, 20);

  // 4b. Slot777 payline + colMult + /api/slot/gamble verification
  let slotWinBetId = null;
  for (let i = 0; i < 30; i++) {
    const sp = await reqJson('/api/bet/play', {
      method: 'POST', headers: hU,
      body: JSON.stringify({ gameName: 'Slot777', betAmount: 2, clientData: {} })
    });
    assert.equal(sp.status, 200);
    assert.ok([1, 2, 3, 4, 5].includes(sp.body.visualOutcome.colMult));
    assert.ok(
      sp.body.isWin
        ? ['TOP', 'CENTER', 'BOTTOM', 'DIAG1', 'DIAG2'].includes(sp.body.visualOutcome.payline)
        : ['NONE', 'TOP', 'CENTER', 'BOTTOM', 'DIAG1', 'DIAG2'].includes(sp.body.visualOutcome.payline)
    );
    if (sp.body.isWin && sp.body.payout > 0) {
      slotWinBetId = sp.body.betId;
      break;
    }
  }
  assert.ok(slotWinBetId, 'Expected at least one winning Slot777 spin within 30 tries');
  const gambleRes = await reqJson('/api/slot/gamble', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ betId: slotWinBetId, choice: 'RED' })
  });
  assert.equal(gambleRes.status, 200);
  assert.equal(gambleRes.body.success, true);
  assert.ok(['RED', 'BLACK'].includes(gambleRes.body.drawnColor));

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

  // 7. Initial default 70% RTP across all casino games + Admin RTP & Bonus settings + cumulative gameStats
  const dash0 = await reqJson('/api/admin/master-dashboard', { headers: hA });
  assert.equal(dash0.status, 200);
  assert.equal(dash0.body.settings.targetRtp, 70);
  assert.equal(dash0.body.settings.kenoRtp, 70);
  assert.equal(dash0.body.settings.buffaloRtp, 70);
  const kPt = await reqJson('/api/keno/paytable');
  assert.equal(kPt.status, 200);
  assert.deepEqual(kPt.body.paytable['1'], [0, 2.8]);

  const upSet = await reqJson('/api/admin/update-settings', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ targetRtp: 0.88, kenoRtp: 0.74, agentCommission: 0.03, welcomeBonus: 30, referralBonus: 75, cashbackPercent: 15, firstDepBonusPct: 20, firstDepBonusMin: 300, wagerReqMult: 50 })
  });
  assert.equal(upSet.status, 200);

  const dash = await reqJson('/api/admin/master-dashboard', { headers: hA });
  assert.equal(dash.status, 200);
  assert.equal(dash.body.settings.kenoRtp, 74);
  assert.equal(dash.body.settings.welcomeBonus, 30);
  assert.equal(dash.body.settings.referralBonus, 75);
  assert.equal(dash.body.settings.cashbackPercent, 15);
  assert.equal(dash.body.settings.firstDepBonusPct, 20);
  assert.equal(dash.body.settings.wagerReqMult, 50);
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
  assert.equal(top2.body.bonusAwarded, 0); // not first deposit
  const dash2 = await reqJson('/api/admin/master-dashboard', { headers: hA });
  assert.equal(dash2.status, 200);
  const uAfter = dash2.body.users.find(u => u.id === init.body.userId);
  assert.ok(uAfter && uAfter.balance > dash.body.users.find(u => u.id === init.body.userId).balance);

  // 10. Withdrawal Agent PIN setup, login isolation & strictly withdrawal-only permissions
  const AGENT_PIN = 'agent7788';
  const pinSt0 = await reqJson('/api/agent/pin-status');
  assert.equal(pinSt0.status, 200);
  assert.equal(pinSt0.body.configured, false);

  const setupRes = await reqJson('/api/agent/setup-pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: AGENT_PIN })
  });
  assert.equal(setupRes.status, 200);

  const setupAgain = await reqJson('/api/agent/setup-pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: 'another99' })
  });
  assert.equal(setupAgain.status, 409);

  const agentLogin = await reqJson('/api/auth/admin-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: AGENT_PIN, mode: 'agent', actor: 'Cashier1' })
  });
  assert.equal(agentLogin.status, 200);
  assert.equal(agentLogin.body.role, 'agent');

  const hAg = { 'Content-Type': 'application/json', 'x-agent-token': AGENT_PIN };

  // Reset launch DB + welcomeBonus=0 to verify end-to-end withdrawal approve & reject by Agent
  const rst = await reqJson('/api/admin/reset-launch-db', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ confirm: 'RESET 200K', vaultBalance: 200000 })
  });
  assert.equal(rst.status, 200);

  await reqJson('/api/admin/update-settings', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ welcomeBonus: 0 })
  });
  const uClean = await reqJson('/api/user/init', { headers: hU });
  assert.equal(uClean.body.balance, 0);

  // Deposit 250 (< 300 -> 0 bonus & 0 wager requirement), satisfy 1x turnover via Sportsbook cashout
  const topClean = await reqJson('/api/admin/topup', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ userId: uClean.body.userId, amount: 250 })
  });
  assert.equal(topClean.status, 200);
  assert.equal(topClean.body.bonusAwarded, 0);

  const m2 = await reqJson('/api/admin/sports/create', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ sport: 'Soccer', league: 'EPL', home: 'Adama', away: 'Bahir Dar' })
  });
  const sbClean = await reqJson('/api/sports/bet', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ matchId: m2.body.match.id, market: m2.body.match.markets[0].label, stake: 250 })
  });
  assert.equal(sbClean.status, 200);
  const coClean = await reqJson('/api/sports/cashout', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ ticketId: sbClean.body.ticket.id })
  });
  assert.equal(coClean.status, 200);
  assert.ok(coClean.body.newBalance >= 200);

  const wd1 = await reqJson('/api/cashier/withdraw', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ amount: 100, accountNumber: '0911223344', method: 'Telebirr' })
  });
  assert.equal(wd1.status, 200);

  const wd2 = await reqJson('/api/cashier/withdraw', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ amount: 100, accountNumber: '0911223344', method: 'CBE' })
  });
  assert.equal(wd2.status, 200);

  const agQueue = await reqJson('/api/agent/withdrawals', { headers: hAg });
  assert.equal(agQueue.status, 200);
  assert.equal(agQueue.body.role, 'agent');
  assert.equal(agQueue.body.pendingWithdrawals.length, 2);

  const agApprove = await reqJson('/api/agent/approve-withdrawal', {
    method: 'POST', headers: hAg,
    body: JSON.stringify({ txnId: wd1.body.txnId })
  });
  assert.equal(agApprove.status, 200);

  const agReject = await reqJson('/api/agent/reject-withdrawal', {
    method: 'POST', headers: hAg,
    body: JSON.stringify({ txnId: wd2.body.txnId, reason: 'Invalid CBE account' })
  });
  assert.equal(agReject.status, 200);

  const uFinal = await reqJson('/api/user/init', { headers: hU });
  assert.ok(Math.abs(uFinal.body.balance - (coClean.body.newBalance - 100)) < 0.02);

  // 11. Regression guard: cashback, lucky spin, adjustment & FDB inserts must populate net_amount
  const adjRes = await reqJson('/api/admin/adjust-balance', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ userId: uClean.body.userId, amount: 200, action: 'ADD', reason: 'net_amount check' })
  });
  assert.equal(adjRes.status, 200);

  const mLoss = await reqJson('/api/admin/sports/create', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ sport: 'Soccer', league: 'EPL', home: 'Hawassa', away: 'Dire Dawa' })
  });
  assert.equal(mLoss.status, 200);
  const sbLoss = await reqJson('/api/sports/bet', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ matchId: mLoss.body.match.id, market: mLoss.body.match.markets[0].label, stake: 150 })
  });
  assert.equal(sbLoss.status, 200);
  const settleLoss = await reqJson('/api/admin/sports/settle', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ matchId: mLoss.body.match.id, homeScore: 0, awayScore: 2 })
  });
  assert.equal(settleLoss.status, 200);

  const cbRes = await reqJson('/api/admin/distribute-cashback', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ percentage: 10, minLoss: 50 })
  });
  assert.equal(cbRes.status, 200);

  const dashFinal = await reqJson('/api/admin/master-dashboard', { headers: hA });
  assert.equal(dashFinal.status, 200);
  const cbTx = dashFinal.body.recentTransactions.find(t => t.type === 'BONUS' && t.method === 'Cashback');
  const adjTx = dashFinal.body.recentTransactions.find(t => t.type === 'ADJUSTMENT');
  assert.ok(cbTx && Number(cbTx.net_amount) === Number(cbTx.amount), 'Cashback transaction must populate net_amount');
  assert.ok(adjTx && Number(adjTx.net_amount) === 200, 'Adjustment transaction must populate net_amount');

  const serverSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const inserts = [...serverSrc.matchAll(/INSERT INTO transactions\s*\(([^)]+)\)/gi)];
  assert.ok(inserts.length >= 9);
  for (const m of inserts) {
    assert.ok(/\bnet_amount\b/i.test(m[1]), `INSERT INTO transactions must include net_amount: ${m[0]}`);
  }

  for (const forbidden of [
    ['/api/admin/master-dashboard', 'GET'],
    ['/api/admin/users', 'GET'],
    ['/api/admin/approve-deposit', 'POST'],
    ['/api/admin/update-settings', 'POST'],
    ['/api/admin/reset-launch-db', 'POST']
  ]) {
    const blocked = await reqJson(forbidden[0], { method: forbidden[1], headers: { 'Content-Type': 'application/json', 'x-admin-token': AGENT_PIN }, body: forbidden[1] === 'POST' ? '{}' : undefined });
    assert.equal(blocked.status, 403, `Agent PIN must be denied access to ${forbidden[0]}`);
  }
});
