'use strict';
const express = require('express');
const crypto = require('crypto');
const math = require('../lib/game-math');
const { computeBetProgress, computeSettlementOdds } = require('../lib/bonus-engine');

const { createCrashEngine } = require('./crash-engine');

/**
 * Shared transaction & crash settlement processors used by individual game modules.
 */
function createSharedHelpers(ctx) {
  const {
    pool, io, CONFIG, Biz, tx, audit, lockUser,
    validWager, newId, mask, parseJson, vaultAdd, flights, r2, num, cache, cacheInvalidate
  } = ctx;

  const crashEngine = createCrashEngine(ctx);

  const gameRtp = g => {
    if (g === 'KenoFast' || g === 'ClassicKeno') return CONFIG.KENO_RTP;
    if (g === 'YoungBuffalo') return CONFIG.BUFFALO_RTP;
    return CONFIG.TARGET_RTP;
  };

  async function creditWin(c, uid, payout, betId, vd, auditTag = 'CHICKEN_WIN', mult = 0) {
    if (!(payout > 0)) return num((await c.query('SELECT balance FROM users WHERE user_id=$1', [uid])).rows[0].balance);
    const uRow = (await c.query('SELECT balance,total_deposited,first_deposit_completed,deposit_odds_left FROM users WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
    const before = num(uRow.balance);
    const after = r2(before + payout);
    const nextOddsLeft = computeSettlementOdds({
      totalDeposited: uRow.total_deposited,
      firstDepositCompleted: uRow.first_deposit_completed,
      depositOddsLeft: uRow.deposit_odds_left,
      oddDelta: num(mult) >= 1.20 ? num(mult) : 0
    });
    await c.query('UPDATE users SET balance=$1,total_won=total_won+$2,deposit_odds_left=$3 WHERE user_id=$4', [after, payout, nextOddsLeft, uid]);
    vd.push({ bal: -payout, payouts: payout, profit: -payout });
    await audit(c, uid, auditTag, payout, before, after, betId);
    return after;
  }

  async function balanceOf(c, uid) {
    return num((await c.query('SELECT balance FROM users WHERE user_id=$1', [uid])).rows[0].balance);
  }

  async function processInstantBet(req, gameName) {
    const { clientData } = req.body || {};
    const wager = validWager(req.body?.betAmount);
    const uid = req.tg.id;

    let g;
    try {
      const kenoSecret = CONFIG.KENO_SECRET || process.env.ADMIN_PIN || 'hulu-keno-secret';
      g = math.resolveInstant(gameName, wager, clientData || {}, gameRtp(gameName), CONFIG.MAX_PAYOUT, { kenoSecret });
    } catch (e) {
      if (e instanceof math.Bad) throw new Biz(e.message);
      throw e;
    }

    const out = await tx(async c => {
      const user = await lockUser(c, uid);
      const bal = num(user.balance);
      if (bal < wager) throw new Biz('Insufficient balance');

      const visual = g.visual, tier = g.tier, roll = g.roll;
      const payout = Math.min(r2(g.payout), CONFIG.MAX_PAYOUT);
      const multiplier = r2(payout / wager);
      const isWin = payout > 0;
      const profit = r2(wager - payout);
      const newBal = r2(bal - wager + payout);
      const betId = newId('BET');
      const prog = computeBetProgress({
        bonusBalance: user.bonus_balance,
        wagerRequirementLeft: user.wager_requirement_left,
        totalDeposited: user.total_deposited,
        firstDepositCompleted: user.first_deposit_completed,
        depositOddsLeft: user.deposit_odds_left,
        wager,
        oddDelta: Math.max(1, multiplier)
      });

      await c.query(
        `UPDATE users SET balance=$1,total_wagered=total_wagered+$2,total_won=total_won+$3,
         bonus_balance=$4,wager_requirement_left=$5,deposit_odds_left=$6,last_active_at=NOW() WHERE user_id=$7`,
        [newBal, wager, payout, prog.newBonusBalance, prog.newWagerRequirementLeft, prog.newDepositOddsLeft, uid]
      );
      await c.query(
        `INSERT INTO universal_bets (bet_id,game_name,user_id,username,bet_amount,rng_roll,tier_applied,multiplier,payout,house_profit,status,game_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [betId, gameName, uid, user.telegram_username, wager, roll, tier, multiplier, payout, profit, isWin ? 'WON' : 'LOST', JSON.stringify(visual)]
      );
      await audit(c, uid, isWin ? 'WIN' : 'BET_LOSS', isWin ? payout : wager, bal, newBal, betId);
      return { betId, multiplier, payout, isWin, newBal, visual, profit, wager, uname: user.telegram_username };
    });

    vaultAdd({ bal: out.profit, wagered: out.wager, payouts: out.payout, profit: out.profit });
    if (cacheInvalidate) {
      cacheInvalidate(`userhist:${uid}:`);
      if (out.payout >= 100) cacheInvalidate('feed:');
      if (gameName === 'KenoFast') cacheInvalidate('keno_results:');
      if (gameName === 'ClassicKeno') cacheInvalidate('classic_keno_results:');
    }
    if (out.payout >= 500) io.emit('live_win', { user: mask(out.uname), game: gameName, win: out.payout });

    return {
      success: true,
      betId: out.betId,
      multiplier: out.multiplier,
      payout: out.payout,
      isWin: out.isWin,
      newBalance: out.newBal,
      visualOutcome: out.visual
    };
  }

  const CRASH_GAMES = ['Aviator', 'JetX'];

  async function placeCrashBets(req, gameName) {
    const { bets } = req.body || {};
    if (!CRASH_GAMES.includes(gameName)) throw new Biz('Invalid game');
    if (!Array.isArray(bets) || bets.length < 1 || bets.length > 2) throw new Biz('Send 1 or 2 bets');

    const items = bets.map(b => {
      const auto = b.auto ? r2(b.auto) : null;
      if (auto !== null && !(auto >= 1.01 && auto <= CONFIG.MAX_CRASH)) throw new Biz('Invalid auto-cashout value');
      return { wager: validWager(b.amount), auto };
    });
    const total = r2(items.reduce((a, b) => a + b.wager, 0));
    const uid = req.tg.id;

    const out = await tx(async c => {
      const user = await lockUser(c, uid);
      const bal = num(user.balance);
      if (bal < total) throw new Biz('Insufficient balance');
      const open = await c.query(
        `SELECT COUNT(*) n FROM universal_bets WHERE user_id=$1 AND status='IN_FLIGHT' AND flight_start > NOW() - INTERVAL '6 minutes'`,
        [uid]
      );
      if (Number(open.rows[0].n) >= 4) throw new Biz('Finish your open rounds first');

      const roundId = newId('RND');
      const seed = crypto.randomBytes(32).toString('hex');
      const commit = crypto.createHash('sha256').update(seed).digest('hex');
      const cp = math.crashPointFromSeed(seed, roundId, CONFIG.TARGET_RTP, CONFIG.MAX_CRASH);
      const newBal = r2(bal - total);
      const prog = computeBetProgress({
        bonusBalance: user.bonus_balance,
        wagerRequirementLeft: user.wager_requirement_left,
        totalDeposited: user.total_deposited,
        firstDepositCompleted: user.first_deposit_completed,
        depositOddsLeft: user.deposit_odds_left,
        wager: total,
        oddDelta: 0
      });

      await c.query(
        `UPDATE users SET balance=$1,total_wagered=total_wagered+$2,
         bonus_balance=$3,wager_requirement_left=$4,deposit_odds_left=$5,last_active_at=NOW() WHERE user_id=$6`,
        [newBal, total, prog.newBonusBalance, prog.newWagerRequirementLeft, prog.newDepositOddsLeft, uid]
      );

      const ids = [];
      const t0 = new Date();
      for (const it of items) {
        const betId = newId('BET');
        ids.push(betId);
        await c.query(
          `INSERT INTO universal_bets (bet_id,game_name,user_id,username,bet_amount,rng_roll,tier_applied,multiplier,payout,house_profit,status,game_data,flight_start)
           VALUES ($1,$2,$3,$4,$5,0,'Crash',0,0,0,'IN_FLIGHT',$6,$7)`,
          [betId, gameName, uid, user.telegram_username, it.wager, JSON.stringify({ seed, commit, crashPoint: cp, auto: it.auto, roundId }), t0]
        );
      }
      await audit(c, uid, 'BET_TAKEOFF', total, bal, newBal, roundId);
      return { roundId, commit, ids, newBal, cp, t0: t0.getTime() };
    });

    vaultAdd({ bal: total, wagered: total, profit: total });
    out.ids.forEach((id, i) => flights.set(id, { uid, cp: out.cp, auto: items[i].auto, start: out.t0 }));

    return {
      success: true,
      roundId: out.roundId,
      commit: out.commit,
      betIds: out.ids,
      newBalance: out.newBal,
      growth: { a: math.CRASH_A, b: math.CRASH_B, c: math.CRASH_C }
    };
  }

  async function resolveCrash(c, betId, uid, opts = {}) {
    if (!opts.locked) {
      const head = await c.query(`SELECT game_data FROM universal_bets WHERE bet_id=$1 AND user_id=$2 AND game_name=ANY($3)`, [betId, uid, CRASH_GAMES]);
      if (!head.rows.length) throw new Biz('Bet not found', 404);
      await c.query(
        `SELECT bet_id FROM universal_bets WHERE user_id=$1 AND game_name=ANY($3) AND (CASE WHEN game_name=ANY($3) THEN game_data::jsonb->>'roundId' END)=$2 ORDER BY bet_id FOR UPDATE`,
        [uid, parseJson(head.rows[0].game_data).roundId || null, CRASH_GAMES]
      );
    }
    const r = await c.query(`SELECT * FROM universal_bets WHERE bet_id=$1 AND user_id=$2 AND game_name=ANY($3)`, [betId, uid, CRASH_GAMES]);
    if (!r.rows.length) throw new Biz('Bet not found', 404);
    const b = r.rows[0], gd = parseJson(b.game_data), wager = num(b.bet_amount);
    const start = b.flight_start ? new Date(b.flight_start).getTime() : 0;
    const bal = async () => num((await c.query('SELECT balance FROM users WHERE user_id=$1', [uid])).rows[0].balance);

    const reveal = async () => {
      const s = await c.query(
        `SELECT 1 FROM universal_bets WHERE status='IN_FLIGHT' AND bet_id<>$1 AND user_id=$2 AND game_name=ANY($4)
         AND (CASE WHEN game_name=ANY($4) THEN game_data::jsonb->>'roundId' END)=$3 LIMIT 1`,
        [betId, uid, gd.roundId || null, CRASH_GAMES]
      );
      return s.rows.length ? {} : { crashPoint: gd.crashPoint, serverSeed: gd.seed, commit: gd.commit };
    };

    if (b.status !== 'IN_FLIGHT') {
      flights.delete(betId);
      return { state: b.status === 'WON' ? 'WON' : 'CRASHED', multiplier: num(b.multiplier), payout: num(b.payout), newBalance: await bal(), ...(await reveal()) };
    }

    const d = math.decideCrash({
      cp: gd.crashPoint,
      auto: gd.auto,
      el: start ? (Date.now() - start) / 1000 : 1e6,
      cashout: !!opts.cashout,
      clientMult: opts.clientMult
    });

    if (d.state === 'FLYING') {
      flights.set(betId, { uid, cp: gd.crashPoint, auto: gd.auto, start });
      return { state: 'FLYING' };
    }
    if (d.state === 'EARLY') throw new Biz('Too early to cash out');

    let payout = 0, mult = 0;
    if (d.state === 'WON') {
      mult = d.mult;
      payout = Math.min(r2(wager * mult), CONFIG.MAX_PAYOUT);
      const uRow = (await c.query('SELECT balance,total_deposited,first_deposit_completed,deposit_odds_left FROM users WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
      const before = num(uRow.balance);
      const after = r2(before + payout);
      const nextOddsLeft = computeSettlementOdds({
        totalDeposited: uRow.total_deposited,
        firstDepositCompleted: uRow.first_deposit_completed,
        depositOddsLeft: uRow.deposit_odds_left,
        oddDelta: mult >= 1.20 ? mult : 0
      });
      await c.query('UPDATE users SET balance=$1,total_won=total_won+$2,deposit_odds_left=$3 WHERE user_id=$4', [after, payout, nextOddsLeft, uid]);
      if (opts.vd) opts.vd.push({ bal: -payout, payouts: payout, profit: -payout });
      await audit(c, uid, 'CASHOUT_WIN', payout, before, after, betId);
    } else if (d.state === 'CRASHED') {
      const uRow = (await c.query('SELECT total_deposited,first_deposit_completed,deposit_odds_left FROM users WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
      if (uRow) {
        const nextOddsLeft = computeSettlementOdds({
          totalDeposited: uRow.total_deposited,
          firstDepositCompleted: uRow.first_deposit_completed,
          depositOddsLeft: uRow.deposit_odds_left,
          oddDelta: 1
        });
        await c.query('UPDATE users SET deposit_odds_left=$1 WHERE user_id=$2', [nextOddsLeft, uid]);
      }
    }

    await c.query(`UPDATE universal_bets SET status=$1,multiplier=$2,payout=$3,house_profit=$4 WHERE bet_id=$5`, [
      d.state === 'WON' ? 'WON' : 'LOST', mult, payout, r2(wager - payout), betId
    ]);
    flights.delete(betId);

    if (d.state === 'CRASHED') {
      const sib = await c.query(
        `SELECT bet_id FROM universal_bets WHERE status='IN_FLIGHT' AND bet_id<>$1 AND user_id=$2 AND game_name=ANY($4)
         AND (CASE WHEN game_name=ANY($4) THEN game_data::jsonb->>'roundId' END)=$3 ORDER BY bet_id`,
        [betId, uid, gd.roundId || null, CRASH_GAMES]
      );
      for (const s of sib.rows) await resolveCrash(c, s.bet_id, uid, { vd: opts.vd, locked: true });
    }

    return { state: d.state === 'WON' ? 'WON' : 'CRASHED', multiplier: mult, payout, newBalance: await bal(), ...(await reveal()) };
  }

  async function settleCrashRoute(req, res, cashout) {
    const betId = String((cashout ? req.body?.betId : req.query?.betId) || '');
    if (!betId) throw new Biz('betId required');
    if (cashout) {
      const liveOut = await crashEngine.cashoutRoomBet(req);
      if (liveOut) return res.json(liveOut);
    }
    if (!cashout) {
      const f = flights.get(betId);
      if (f && f.uid === req.tg.id && math.decideCrash({ cp: f.cp, auto: f.auto, el: (Date.now() - f.start) / 1000, cashout: false }).state === 'FLYING') {
        return res.json({ success: true, state: 'FLYING' });
      }
    }
    const res2 = await tx(async c => {
      const vd = [];
      const r = await resolveCrash(c, betId, req.tg.id, { cashout, clientMult: req.body?.clientMult, vd });
      return { r, vd };
    });
    res2.vd.forEach(vaultAdd);
    const out = res2.r;
    if (cacheInvalidate && out.state !== 'FLYING') cacheInvalidate(`userhist:${req.tg.id}:`);
    if (out.state === 'WON' && out.payout >= 500) io.emit('live_win', { user: mask(req.tg.username), game: 'Crash', win: out.payout });
    res.json({ success: true, ...out });
  }

  function createCrashRouter(gameName) {
    const router = express.Router();
    router.post('/bet', ctx.userAuth, ctx.limit('crash', 120, 60e3), ctx.h(async (req, res) => {
      if (req.body?.roundId) {
        return res.json(await crashEngine.placeRoomBet(req, gameName));
      }
      res.json(await placeCrashBets(req, gameName));
    }));
    router.post('/cancel', ctx.userAuth, ctx.limit('crash', 120, 60e3), ctx.h(async (req, res) => {
      res.json(await crashEngine.cancelRoomBet(req));
    }));
    router.get('/room', ctx.limit('feed', 120, 60e3), ctx.h(async (req, res) => {
      const auth = ctx.parseInitData ? ctx.parseInitData(req.headers['x-telegram-init-data'] || req.query?.initData) : null;
      res.json(crashEngine.getRoomState(gameName, auth?.id || null));
    }));
    router.get('/status', ctx.userAuth, ctx.limit('crashstat', 600, 60e3), ctx.h((req, res) => settleCrashRoute(req, res, false)));
    router.post('/cashout', ctx.userAuth, ctx.limit('crash', 120, 60e3), ctx.h((req, res) => settleCrashRoute(req, res, true)));
    router.get('/feed', ctx.limit('feed', 60, 60e3), ctx.h(async (_req, res) => {
      const load = async () => {
        const c = await pool.query(`SELECT game_data FROM universal_bets WHERE game_name=$1 AND status IN ('WON','LOST') ORDER BY created_at DESC LIMIT 30`, [gameName]);
        const seen = new Set(), crashes = [];
        for (const r of c.rows) {
          const g = parseJson(r.game_data);
          if (g.roundId && !seen.has(g.roundId)) { seen.add(g.roundId); crashes.push(g.crashPoint); }
          if (crashes.length >= 15) break;
        }
        return crashes;
      };
      const crashes = cache ? await cache.getOrLoad(`game_feed:${gameName}`, 5000, load) : await load();
      res.json({ success: true, game: gameName, crashes });
    }));
    return router;
  }

  return {
    gameRtp,
    creditWin,
    balanceOf,
    processInstantBet,
    placeCrashBets,
    resolveCrash,
    settleCrashRoute,
    createCrashRouter,
    crashEngine,
    CRASH_GAMES
  };
}

module.exports = { createSharedHelpers };
