'use strict';
const express = require('express');
const crypto = require('crypto');
const math = require('../lib/game-math');
const { computeBetProgress, computeSettlementOdds } = require('../lib/bonus-engine');

module.exports = function createLuckyChickenModule(ctx, shared) {
  const GAME_NAME = 'LuckyChicken';
  const router = express.Router();
  const { pool, io, CONFIG, Biz, tx, audit, lockUser, validWager, newId, mask, parseJson, vaultAdd, r2, num } = ctx;

  const configHandler = (_req, res) => res.json({ success: true, game: GAME_NAME, lanes: math.CHICKEN.easy.length, tables: math.CHICKEN });

  const startHandler = ctx.h(async (req, res) => {
    const diff = String(req.body?.difficulty || '');
    if (!math.CHICKEN[diff]) throw new Biz('Invalid difficulty');
    const wager = validWager(req.body?.betAmount);
    const uid = req.tg.id;
    const S = math.chickenSurvival(diff, CONFIG.TARGET_RTP);
    const u = crypto.randomInt(0, 1e9) / 1e9;

    const out = await tx(async c => {
      const user = await lockUser(c, uid), bal = num(user.balance);
      if (bal < wager) throw new Biz('Insufficient balance');
      const open = await c.query(
        `SELECT 1 FROM universal_bets WHERE user_id=$1 AND game_name=$2 AND status='IN_FLIGHT' AND flight_start > NOW() - INTERVAL '10 minutes' LIMIT 1`,
        [uid, GAME_NAME]
      );
      if (open.rows.length) throw new Biz('Finish your current chicken round first');
      const betId = newId('BET'), newBal = r2(bal - wager);
      const prog = computeBetProgress({
        bonusBalance: user.bonus_balance,
        wagerRequirementLeft: user.wager_requirement_left,
        totalDeposited: user.total_deposited,
        firstDepositCompleted: user.first_deposit_completed,
        depositOddsLeft: user.deposit_odds_left,
        wager,
        oddDelta: 0
      });
      await c.query(
        `UPDATE users SET balance=$1,total_wagered=total_wagered+$2,bonus_balance=$3,wager_requirement_left=$4,deposit_odds_left=$5,last_active_at=NOW() WHERE user_id=$6`,
        [newBal, wager, prog.newBonusBalance, prog.newWagerRequirementLeft, prog.newDepositOddsLeft, uid]
      );
      await c.query(
        `INSERT INTO universal_bets (bet_id,game_name,user_id,username,bet_amount,rng_roll,tier_applied,multiplier,payout,house_profit,status,game_data,flight_start)
         VALUES ($1,$2,$3,$4,$5,0,$6,0,0,0,'IN_FLIGHT',$7,$8)`,
        [betId, GAME_NAME, uid, user.telegram_username, wager, 'Chicken ' + diff, JSON.stringify({ difficulty: diff, u, S, step: 0 }), new Date()]
      );
      await audit(c, uid, 'BET_START', wager, bal, newBal, betId);
      return { betId, newBal };
    });

    vaultAdd({ bal: wager, wagered: wager, profit: wager });
    res.json({ success: true, betId: out.betId, difficulty: diff, mults: math.CHICKEN[diff], lanes: math.CHICKEN[diff].length, newBalance: out.newBal });
  });

  const activeHandler = ctx.h(async (req, res) => {
    const r = await pool.query(
      `SELECT bet_id,bet_amount,game_data FROM universal_bets WHERE user_id=$1 AND game_name=$2 AND status='IN_FLIGHT' AND flight_start > NOW() - INTERVAL '10 minutes' ORDER BY flight_start DESC LIMIT 1`,
      [req.tg.id, GAME_NAME]
    );
    if (!r.rows.length) return res.json({ success: true, active: null });
    const gd = parseJson(r.rows[0].game_data);
    res.json({
      success: true,
      active: { betId: r.rows[0].bet_id, betAmount: num(r.rows[0].bet_amount), difficulty: gd.difficulty, step: gd.step, mults: math.CHICKEN[gd.difficulty] }
    });
  });

  const stepHandler = ctx.h(async (req, res) => {
    const betId = String(req.body?.betId || ''), uid = req.tg.id;
    const o = await tx(async c => {
      const vd = [];
      const r = await c.query(`SELECT * FROM universal_bets WHERE bet_id=$1 AND user_id=$2 AND game_name=$3 FOR UPDATE`, [betId, uid, GAME_NAME]);
      if (!r.rows.length) throw new Biz('Round not found', 404);
      const b = r.rows[0], gd = parseJson(b.game_data), wager = num(b.bet_amount);
      if (b.status !== 'IN_FLIGHT') throw new Biz('This round is already finished');
      const m = math.CHICKEN[gd.difficulty];
      if (!m) throw new Biz('Invalid difficulty');
      const curStep = Number(gd.step || 0);
      if (curStep >= m.length) throw new Biz('This round is already finished');
      const step = curStep + 1, alive = gd.u < (gd.S[step - 1] ?? 0);
      if (!alive) {
        await c.query(`UPDATE universal_bets SET status='LOST',multiplier=0,payout=0,house_profit=$1,game_data=$2 WHERE bet_id=$3`, [wager, JSON.stringify({ ...gd, step }), betId]);
        const uRow = await lockUser(c, uid);
        const nextOddsLeft = computeSettlementOdds({
          totalDeposited: uRow.total_deposited,
          firstDepositCompleted: uRow.first_deposit_completed,
          depositOddsLeft: uRow.deposit_odds_left,
          oddDelta: 1
        });
        await c.query('UPDATE users SET deposit_odds_left=$1 WHERE user_id=$2', [nextOddsLeft, uid]);
        return { vd, body: { state: 'HIT', step, payout: 0, newBalance: num(uRow.balance) } };
      }
      if (step >= m.length) {
        const payout = Math.min(r2(wager * m[step - 1]), CONFIG.MAX_PAYOUT);
        await c.query(`UPDATE universal_bets SET status='WON',multiplier=$1,payout=$2,house_profit=$3,game_data=$4 WHERE bet_id=$5`, [m[step - 1], payout, r2(wager - payout), JSON.stringify({ ...gd, step }), betId]);
        const nb = await shared.creditWin(c, uid, payout, betId, vd, 'CHICKEN_WIN', m[step - 1]);
        return { vd, body: { state: 'GOAL', step, multiplier: m[step - 1], payout, newBalance: nb } };
      }
      await c.query(`UPDATE universal_bets SET game_data=$1 WHERE bet_id=$2`, [JSON.stringify({ ...gd, step }), betId]);
      return { vd, body: { state: 'SAFE', step, multiplier: m[step - 1], potential: r2(wager * m[step - 1]), newBalance: await shared.balanceOf(c, uid) } };
    });
    o.vd.forEach(vaultAdd);
    if (ctx.cacheInvalidate && (o.body.state === 'HIT' || o.body.state === 'GOAL')) ctx.cacheInvalidate(`userhist:${uid}:`);
    if (o.body.state === 'GOAL' && o.body.payout >= 500) io.emit('live_win', { user: mask(req.tg.username), game: GAME_NAME, win: o.body.payout });
    res.json({ success: true, ...o.body });
  });

  async function chickenCashout(c, betId, uid, vd, stale) {
    const r = await c.query(`SELECT * FROM universal_bets WHERE bet_id=$1 AND user_id=$2 AND game_name=$3 FOR UPDATE`, [betId, uid, GAME_NAME]);
    if (!r.rows.length) throw new Biz('Round not found', 404);
    const b = r.rows[0], gd = parseJson(b.game_data), wager = num(b.bet_amount);
    if (b.status !== 'IN_FLIGHT') throw new Biz('This round is already finished');
    if (gd.step < 1) {
      if (!stale) throw new Biz('Take at least one step before cashing out');
      const before = await shared.balanceOf(c, uid);
      await c.query('UPDATE users SET balance=balance+$1,total_wagered=GREATEST(0,total_wagered-$1) WHERE user_id=$2', [wager, uid]);
      await c.query(`UPDATE universal_bets SET status='VOID',multiplier=0,payout=$1,house_profit=0 WHERE bet_id=$2`, [wager, betId]);
      vd.push({ bal: -wager, wagered: -wager, profit: -wager });
      await audit(c, uid, 'CHICKEN_VOID', wager, before, r2(before + wager), betId);
      return { state: 'VOID', payout: wager, multiplier: 1, newBalance: r2(before + wager) };
    }
    const mult = math.CHICKEN[gd.difficulty][gd.step - 1], payout = Math.min(r2(wager * mult), CONFIG.MAX_PAYOUT);
    await c.query(`UPDATE universal_bets SET status='WON',multiplier=$1,payout=$2,house_profit=$3 WHERE bet_id=$4`, [mult, payout, r2(wager - payout), betId]);
    const nb = await shared.creditWin(c, uid, payout, betId, vd, 'CHICKEN_WIN', mult);
    return { state: 'WON', step: gd.step, multiplier: mult, payout, newBalance: nb };
  }

  const cashoutHandler = ctx.h(async (req, res) => {
    const o = await tx(async c => {
      const vd = [];
      const body = await chickenCashout(c, String(req.body?.betId || ''), req.tg.id, vd, false);
      return { vd, body };
    });
    o.vd.forEach(vaultAdd);
    if (ctx.cacheInvalidate) ctx.cacheInvalidate(`userhist:${req.tg.id}:`);
    res.json({ success: true, ...o.body });
  });

  async function settleStale() {
    const r = await pool.query(
      `SELECT bet_id,user_id FROM universal_bets WHERE game_name=$1 AND status='IN_FLIGHT' AND flight_start < NOW() - INTERVAL '10 minutes' LIMIT 100`,
      [GAME_NAME]
    );
    for (const b of r.rows) {
      try {
        const vd = await tx(async c => { const v = []; await chickenCashout(c, b.bet_id, b.user_id, v, true); return v; });
        vd.forEach(vaultAdd);
      } catch (e) { console.error('chicken sweep', e.message); }
    }
  }

  router.get('/config', configHandler);
  router.post('/start', ctx.userAuth, ctx.limit('chicken', 120, 60e3), startHandler);
  router.get('/active', ctx.userAuth, ctx.limit('chickenstep', 300, 60e3), activeHandler);
  router.post('/step', ctx.userAuth, ctx.limit('chickenstep', 300, 60e3), stepHandler);
  router.post('/cashout', ctx.userAuth, ctx.limit('chickenstep', 300, 60e3), cashoutHandler);

  return {
    name: GAME_NAME,
    slug: 'lucky-chicken',
    routePath: '/Lucky-Chicken-',
    htmlFile: 'Luckychekn.html',
    type: 'interactive',
    router,
    settleStale,
    handlers: { configHandler, startHandler, activeHandler, stepHandler, cashoutHandler }
  };
};
