'use strict';
const express = require('express');
const buffaloMath = require('../lib/buffalo-math');
const { computeBetProgress } = require('../lib/bonus-engine');

module.exports = function createBuffaloModule(ctx) {
  const GAME_NAME = 'YoungBuffalo';
  const router = express.Router();

  const configHandler = (_req, res) => {
    res.json({
      success: true,
      game: GAME_NAME,
      title: 'Young Buffalo Song',
      currency: 'ETB',
      rtp: ctx.r2(ctx.CONFIG.BUFFALO_RTP * 100),
      minBet: 2,
      maxBet: ctx.CONFIG.MAX_BET,
      maxPayout: ctx.CONFIG.MAX_PAYOUT,
      betSteps: buffaloMath.BET_STEPS.filter(b => b <= ctx.CONFIG.MAX_BET),
      paytable: buffaloMath.PAYTABLE,
      scatterPay: buffaloMath.SCATTER_PAY,
      jackpots: buffaloMath.JACKPOTS
    });
  };

  const playHandler = ctx.h(async (req, res) => {
    const rawBet = ctx.r2(req.body?.betAmount);
    if (!Number.isFinite(rawBet) || rawBet < 2 || rawBet > ctx.CONFIG.MAX_BET) {
      throw new ctx.Biz(`Bet must be between 2 and ${ctx.CONFIG.MAX_BET} ETB`);
    }

    const rawBuy = req.body?.bonusBuy ? String(req.body.bonusBuy).trim().toLowerCase() : null;
    if (rawBuy && rawBuy !== 'freespins' && rawBuy !== 'bonus') {
      throw new ctx.Biz('Invalid bonus buy type');
    }

    const uid = req.tg.id;
    const sim = buffaloMath.resolveBuffaloSpin({
      wager: rawBet,
      rtp: ctx.CONFIG.BUFFALO_RTP,
      maxPayout: ctx.CONFIG.MAX_PAYOUT,
      bonusBuy: rawBuy
    });

    const totalCost = sim.totalCost;
    const payout = sim.totalPayout;
    const multiplier = sim.multiplier;
    const isWin = sim.isWin;
    const profit = ctx.r2(totalCost - payout);

    const out = await ctx.tx(async c => {
      const user = await ctx.lockUser(c, uid);
      const bal = ctx.num(user.balance);
      if (bal < totalCost) {
        throw new ctx.Biz(`Insufficient balance (need ${totalCost.toFixed(2)} ETB)`);
      }

      const newBal = ctx.r2(bal - totalCost + payout);
      const betId = ctx.newId('BET');
      const prog = computeBetProgress({
        bonusBalance: user.bonus_balance,
        wagerRequirementLeft: user.wager_requirement_left,
        totalDeposited: user.total_deposited,
        firstDepositCompleted: user.first_deposit_completed,
        depositOddsLeft: user.deposit_odds_left,
        wager: totalCost,
        oddDelta: Math.max(1, multiplier)
      });

      await c.query(
        `UPDATE users SET balance=$1,total_wagered=total_wagered+$2,total_won=total_won+$3,
         bonus_balance=$4,wager_requirement_left=$5,deposit_odds_left=$6,last_active_at=NOW() WHERE user_id=$7`,
        [newBal, totalCost, payout, prog.newBonusBalance, prog.newWagerRequirementLeft, prog.newDepositOddsLeft, uid]
      );

      const compactData = {
        betAmount: rawBet,
        bonusBuy: rawBuy,
        capped: sim.capped,
        baseLineWins: sim.outcome.baseEval.lineWins.length,
        freeSpinsCount: sim.outcome.freeSpins ? sim.outcome.freeSpins.spins.length : 0,
        bonusCoins: sim.outcome.baseBonus ? sim.outcome.baseBonus.lockedCount : 0
      };

      await c.query(
        `INSERT INTO universal_bets (bet_id,game_name,user_id,username,bet_amount,rng_roll,tier_applied,multiplier,payout,house_profit,status,game_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [betId, GAME_NAME, uid, user.telegram_username, totalCost, sim.roll, sim.tier, multiplier, payout, profit, isWin ? 'WON' : 'LOST', JSON.stringify(compactData)]
      );

      await ctx.audit(c, uid, isWin ? 'WIN' : 'BET_LOSS', isWin ? payout : totalCost, bal, newBal, betId);
      return { betId, newBal, uname: user.telegram_username };
    });

    ctx.vaultAdd({ bal: profit, wagered: totalCost, payouts: payout, profit });
    if (ctx.cacheInvalidate) {
      ctx.cacheInvalidate(`userhist:${uid}:`);
      if (payout >= 100) ctx.cacheInvalidate('feed:');
    }
    if (payout >= 500) {
      ctx.io.emit('live_win', { user: ctx.mask(out.uname), game: GAME_NAME, win: payout });
    }

    res.json({
      success: true,
      betId: out.betId,
      game: GAME_NAME,
      betAmount: rawBet,
      totalCost,
      payout,
      multiplier,
      isWin,
      capped: sim.capped,
      newBalance: out.newBal,
      outcome: sim.outcome
    });
  });

  router.get('/config', configHandler);
  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), playHandler);

  return {
    name: GAME_NAME,
    slug: 'buffalo',
    routePath: '/Buffalo',
    htmlFile: 'buffalo.html',
    type: 'instant',
    router,
    configHandler,
    playHandler
  };
};
