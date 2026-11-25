'use strict';
const crypto = require('crypto');
const express = require('express');
const math = require('../lib/game-math');

module.exports = function createSlot777Module(ctx, shared) {
  const GAME_NAME = 'Slot777';
  const router = express.Router();

  const paytableHandler = (_req, res) => {
    const t = math.slotTable(ctx.CONFIG.TARGET_RTP);
    res.json({
      success: true,
      game: GAME_NAME,
      symbols: math.SLOT.ids.map((id, i) => ({
        id,
        weight: math.SLOT.w[i],
        triple: t.triple[i],
        pair: t.pair[i],
        displayTriple: math.SLOT.triple[i],
        displayPair: math.SLOT.pair[i]
      })),
      colMult: math.SLOT.col.map(([m, p]) => ({ mult: m, chance: p })),
      hitRate: Math.round(t.hit * 1000) / 10
    });
  };

  const gambleHandler = ctx.h(async (req, res) => {
    const betId = String(req.body?.betId || '').trim();
    const choice = String(req.body?.choice || '').trim().toUpperCase();
    if (!betId) throw new ctx.Biz('betId is required');
    if (choice !== 'RED' && choice !== 'BLACK') throw new ctx.Biz('Choice must be RED or BLACK');
    const uid = req.tg.id;

    const out = await ctx.tx(async c => {
      const br = await c.query(
        `SELECT * FROM universal_bets WHERE bet_id=$1 AND user_id=$2 AND game_name=$3 FOR UPDATE`,
        [betId, uid, GAME_NAME]
      );
      if (!br.rows.length) throw new ctx.Biz('Slot round not found', 404);
      const b = br.rows[0];
      const gd = ctx.parseJson(b.game_data);
      const curWin = ctx.num(b.payout);
      const wager = ctx.num(b.bet_amount);
      if (b.status !== 'WON' || !(curWin > 0) || gd.gambleState === 'LOST') {
        throw new ctx.Biz('This win is no longer eligible to gamble');
      }
      if (curWin * 2 > ctx.CONFIG.MAX_PAYOUT) {
        throw new ctx.Biz('Maximum payout limit reached for gamble');
      }

      const user = await ctx.lockUser(c, uid);
      const bal = ctx.num(user.balance);
      if (bal < curWin) {
        throw new ctx.Biz('Insufficient balance to stake current win');
      }

      const isRed = crypto.randomInt(0, 2) === 0;
      const drawnColor = isRed ? 'RED' : 'BLACK';
      const drawnSuit = isRed
        ? (crypto.randomInt(0, 2) === 0 ? 'HEART' : 'DIAMOND')
        : (crypto.randomInt(0, 2) === 0 ? 'SPADE' : 'CLUB');
      const won = drawnColor === choice;
      const rounds = Number(gd.gambleRounds || 0) + 1;

      if (won) {
        const nextWin = ctx.r2(curWin * 2);
        const newBal = ctx.r2(bal + curWin);
        const nextMult = wager > 0 ? ctx.r2(nextWin / wager) : 0;
        const nextProfit = ctx.r2(wager - nextWin);
        const nextGd = { ...gd, gambleRounds: rounds, lastGambleColor: drawnColor, gambleState: 'WON' };
        await c.query(
          `UPDATE users SET balance=$1, total_won=total_won+$2 WHERE user_id=$3`,
          [newBal, curWin, uid]
        );
        await c.query(
          `UPDATE universal_bets SET payout=$1, multiplier=$2, house_profit=$3, game_data=$4 WHERE bet_id=$5`,
          [nextWin, nextMult, nextProfit, JSON.stringify(nextGd), betId]
        );
        await ctx.audit(c, uid, 'SLOT_GAMBLE_WIN', curWin, bal, newBal, betId);
        return { won: true, drawnColor, drawnSuit, newWin: nextWin, newBalance: newBal, delta: curWin };
      }

      const newBal = ctx.r2(bal - curWin);
      const nextGd = { ...gd, gambleRounds: rounds, lastGambleColor: drawnColor, gambleState: 'LOST' };
      await c.query(
        `UPDATE users SET balance=$1, total_won=GREATEST(0, total_won-$2) WHERE user_id=$3`,
        [newBal, curWin, uid]
      );
      await c.query(
        `UPDATE universal_bets SET status='LOST', payout=0, multiplier=0, house_profit=$1, game_data=$2 WHERE bet_id=$3`,
        [wager, JSON.stringify(nextGd), betId]
      );
      await ctx.audit(c, uid, 'SLOT_GAMBLE_LOSS', curWin, bal, newBal, betId);
      return { won: false, drawnColor, drawnSuit, newWin: 0, newBalance: newBal, delta: -curWin };
    });

    ctx.vaultAdd({ bal: -out.delta, payouts: out.delta, profit: -out.delta });
    if (ctx.cacheInvalidate) ctx.cacheInvalidate(`userhist:${uid}:`);

    res.json({
      success: true,
      won: out.won,
      drawnColor: out.drawnColor,
      drawnSuit: out.drawnSuit,
      newWin: out.newWin,
      newBalance: out.newBalance
    });
  });

  router.get('/paytable', paytableHandler);
  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));
  router.post('/gamble', ctx.userAuth, ctx.limit('bet', 120, 60e3), gambleHandler);

  return {
    name: GAME_NAME,
    slug: 'slot777',
    routePath: '/Slot-777-',
    htmlFile: 'slot777.html',
    type: 'instant',
    router,
    paytableHandler,
    gambleHandler
  };
};
