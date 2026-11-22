'use strict';

const crypto = require('crypto');
const math = require('../lib/game-math');
const { createRoomState } = require('../lib/crash-room');

/**
 * Real-time Socket.IO + DB-backed Multiplayer Crash Engine for Aviator & JetX.
 * Runs shared continuous rounds on the server and settles every bet/cashout atomically in DB.
 */
function createCrashEngine(ctx) {
  const {
    pool, io, CONFIG, Biz, tx, audit, lockUser,
    validWager, newId, mask, parseJson, vaultAdd, r2, num, parseInitData
  } = ctx;

  const ROOM_NAMES = ['Aviator', 'JetX'];
  const rooms = new Map();

  function makeSeedFactory() {
    return () => {
      const roundId = newId('RND');
      const seed = crypto.randomBytes(32).toString('hex');
      const commit = crypto.createHash('sha256').update(seed).digest('hex');
      const crashPoint = math.crashPointFromSeed(seed, roundId, CONFIG.TARGET_RTP, CONFIG.MAX_CRASH);
      return { roundId, seed, commit, crashPoint };
    };
  }

  for (const name of ROOM_NAMES) {
    const mgr = createRoomState(name, makeSeedFactory());
    mgr.startWaiting(Date.now());
    rooms.set(name, mgr);
  }

  function roomChannel(gameName) {
    return 'crash:' + gameName;
  }

  function userChannel(uid) {
    return 'user:' + String(uid);
  }

  async function seedHistories() {
    for (const [name, mgr] of rooms) {
      try {
        const res = await pool.query(
          `SELECT game_data FROM universal_bets WHERE game_name=$1 AND status IN ('WON','LOST') ORDER BY created_at DESC LIMIT 40`,
          [name]
        );
        const seen = new Set();
        const items = [];
        for (const row of res.rows) {
          const g = parseJson(row.game_data);
          if (g.roundId && Number.isFinite(Number(g.crashPoint)) && !seen.has(g.roundId)) {
            seen.add(g.roundId);
            items.push({ roundId: g.roundId, crashPoint: Number(g.crashPoint), serverSeed: g.seed || '', commit: g.commit || '' });
          }
          if (items.length >= 20) break;
        }
        if (items.length) mgr.room.history = items;
      } catch (e) {
        console.warn(`[CrashEngine] history seed skipped for ${name}:`, e.message);
      }
    }
  }

  function formatMyBets(mgr, uid) {
    if (!uid) return [];
    return mgr.room.bets
      .filter(b => b.userId === String(uid))
      .map(b => ({ ...b }));
  }

  async function persistWinner(b, gameName) {
    try {
      const out = await tx(async c => {
        const cur = await c.query(
          `SELECT * FROM universal_bets WHERE bet_id=$1 AND user_id=$2 AND game_name=$3`,
          [b.betId, b.userId, gameName]
        );
        if (!cur.rows.length || cur.rows[0].status !== 'IN_FLIGHT') return null;

        const wager = num(cur.rows[0].bet_amount);
        const payout = Math.min(r2(b.payout), CONFIG.MAX_PAYOUT);
        const uRes = await c.query('SELECT balance,telegram_username FROM users WHERE user_id=$1 FOR UPDATE', [b.userId]);
        if (!uRes.rows.length) return null;

        const before = num(uRes.rows[0].balance);
        const after = r2(before + payout);
        await c.query('UPDATE users SET balance=$1,total_won=total_won+$2 WHERE user_id=$3', [after, payout, b.userId]);
        await c.query(
          `UPDATE universal_bets SET status=$1,multiplier=$2,payout=$3,house_profit=$4 WHERE bet_id=$5`,
          ['WON', b.multiplier, payout, r2(wager - payout), b.betId]
        );
        await audit(c, b.userId, 'CASHOUT_WIN', payout, before, after, b.betId);
        return { newBalance: after, payout, uname: uRes.rows[0].telegram_username };
      });

      if (out) {
        vaultAdd({ bal: -out.payout, payouts: out.payout, profit: -out.payout });
        io.to(userChannel(b.userId)).emit('crash:balance', { game: gameName, newBalance: out.newBalance });
        if (out.payout >= 500) {
          io.emit('live_win', { user: mask(out.uname), game: gameName, win: out.payout });
        }
      }
    } catch (e) {
      console.error(`[CrashEngine] persistWinner failed (${b.betId}):`, e.message);
    }
  }

  async function persistCrashLosses(crashedBets, gameName) {
    if (!crashedBets.length) return;
    try {
      await tx(async c => {
        for (const b of crashedBets) {
          await c.query(
            `UPDATE universal_bets SET status=$1,multiplier=$2,payout=$3,house_profit=$4 WHERE bet_id=$5`,
            ['LOST', 0, 0, b.wager, b.betId]
          );
        }
      });
      const affectedUsers = [...new Set(crashedBets.map(b => b.userId))];
      for (const uid of affectedUsers) {
        const r = await pool.query('SELECT balance FROM users WHERE user_id=$1', [uid]).catch(() => null);
        if (r && r.rows.length) {
          io.to(userChannel(uid)).emit('crash:balance', { game: gameName, newBalance: num(r.rows[0].balance) });
        }
      }
    } catch (e) {
      console.error(`[CrashEngine] persistCrashLosses failed (${gameName}):`, e.message);
    }
  }

  // Main 100ms authoritative simulation loop for both Aviator & JetX
  let tickBusy = false;
  setInterval(async () => {
    if (tickBusy) return;
    tickBusy = true;
    try {
      const now = Date.now();
      for (const [gameName, mgr] of rooms) {
        const step = mgr.stepTick(now, CONFIG.MAX_PAYOUT);
        const chan = roomChannel(gameName);

        if (step.event === 'TAKEOFF') {
          io.to(chan).emit('crash:phase', step.snapshot);
        } else if (step.event === 'TICK') {
          if (step.autoWins && step.autoWins.length) {
            for (const w of step.autoWins) {
              await persistWinner(w, gameName);
              io.to(chan).emit('crash:cashout', { game: gameName, roundId: mgr.room.roundId, bet: w });
            }
            io.to(chan).emit('crash:bets', { game: gameName, roundId: mgr.room.roundId, bets: mgr.getPublicBets() });
          }
          io.to(chan).emit('crash:tick', {
            game: gameName,
            roundId: mgr.room.roundId,
            mult: step.mult,
            elapsedMs: step.elapsedMs
          });
        } else if (step.event === 'CRASHED') {
          if (step.autoWins && step.autoWins.length) {
            for (const w of step.autoWins) {
              await persistWinner(w, gameName);
              io.to(chan).emit('crash:cashout', { game: gameName, roundId: mgr.room.roundId, bet: w });
            }
          }
          await persistCrashLosses(step.crashedBets || [], gameName);
          io.to(chan).emit('crash:phase', step.snapshot);
        } else if (step.event === 'NEW_ROUND') {
          io.to(chan).emit('crash:phase', step.snapshot);
        }
      }
    } catch (e) {
      console.error('[CrashEngine] loop error:', e.message);
    } finally {
      tickBusy = false;
    }
  }, 100).unref();

  // Socket.IO connection & room handlers
  io.on('connection', socket => {
    socket.on('crash:join', payload => {
      const gameName = payload?.gameName === 'JetX' ? 'JetX' : (payload?.gameName === 'Aviator' ? 'Aviator' : null);
      if (!gameName) return;
      const mgr = rooms.get(gameName);
      if (!mgr) return;

      // Leave previous crash room if switching
      if (socket.data.crashGame && socket.data.crashGame !== gameName) {
        const prevMgr = rooms.get(socket.data.crashGame);
        if (prevMgr) {
          prevMgr.room.players.delete(socket.id);
          io.to(roomChannel(socket.data.crashGame)).emit('crash:players', {
            game: socket.data.crashGame,
            playersCount: Math.max(1, prevMgr.room.players.size)
          });
        }
        socket.leave(roomChannel(socket.data.crashGame));
      }

      const authUser = payload?.initData ? parseInitData(payload.initData) : null;
      const uid = authUser?.id ? String(authUser.id) : null;
      const uname = authUser?.username || authUser?.first_name || 'Player';

      socket.data.crashGame = gameName;
      socket.data.userId = uid;
      socket.join(roomChannel(gameName));
      if (uid) socket.join(userChannel(uid));

      mgr.room.players.set(socket.id, { userId: uid || socket.id, name: uname });

      const now = Date.now();
      socket.emit('crash:state', {
        ...mgr.getPublicSnapshot(now),
        myBets: formatMyBets(mgr, uid)
      });
      io.to(roomChannel(gameName)).emit('crash:players', {
        game: gameName,
        playersCount: Math.max(1, mgr.room.players.size)
      });
    });

    socket.on('disconnect', () => {
      const g = socket.data.crashGame;
      if (!g) return;
      const mgr = rooms.get(g);
      if (!mgr) return;
      mgr.room.players.delete(socket.id);
      io.to(roomChannel(g)).emit('crash:players', {
        game: g,
        playersCount: Math.max(1, mgr.room.players.size)
      });
    });
  });

  async function placeRoomBet(req, gameName) {
    const mgr = rooms.get(gameName);
    if (!mgr) throw new Biz('Invalid crash game');

    const { roundId, bets } = req.body || {};
    if (!Array.isArray(bets) || bets.length < 1 || bets.length > 2) {
      throw new Biz('Send 1 or 2 bets');
    }
    if (mgr.room.phase !== 'WAITING') {
      throw new Biz('Round already flying — wait for next countdown', 409);
    }
    if (roundId && roundId !== mgr.room.roundId) {
      throw new Biz('Round switched — placing on new round soon', 409);
    }

    const activeRoundId = mgr.room.roundId;
    const activeSeed = mgr.room.seed;
    const activeCommit = mgr.room.commit;
    const activeCp = mgr.room.crashPoint;
    const flightStartEst = new Date(mgr.room.waitEndsAt || Date.now() + 5000);

    const items = bets.map((b, idx) => {
      const auto = b.auto ? r2(b.auto) : null;
      if (auto !== null && !(auto >= 1.01 && auto <= CONFIG.MAX_CRASH)) {
        throw new Biz('Invalid auto-cashout value');
      }
      const panelIndex = Number.isInteger(b.panelIndex) ? b.panelIndex : idx;
      return { wager: validWager(b.amount), auto, panelIndex };
    });

    const uid = req.tg.id;
    const existingPanels = new Set(
      mgr.room.bets.filter(b => b.userId === String(uid) && b.status !== 'CANCELLED').map(b => b.panelIndex)
    );
    for (const it of items) {
      if (existingPanels.has(it.panelIndex)) {
        throw new Biz('Panel already active in this round', 409);
      }
    }

    const total = r2(items.reduce((a, b) => a + b.wager, 0));

    const out = await tx(async c => {
      const user = await lockUser(c, uid);
      const bal = num(user.balance);
      if (bal < total) throw new Biz('Insufficient balance');

      const newBal = r2(bal - total);
      await c.query(
        `UPDATE users SET balance=$1,total_wagered=total_wagered+$2,
         wager_requirement_left=GREATEST(0,COALESCE(wager_requirement_left,0)-$2),last_active_at=NOW() WHERE user_id=$3`,
        [newBal, total, uid]
      );

      const ids = [];
      for (const it of items) {
        const betId = newId('BET');
        ids.push(betId);
        await c.query(
          `INSERT INTO universal_bets (bet_id,game_name,user_id,username,bet_amount,rng_roll,tier_applied,multiplier,payout,house_profit,status,game_data,flight_start)
           VALUES ($1,$2,$3,$4,$5,0,'Crash',0,0,0,'IN_FLIGHT',$6,$7)`,
          [
            betId,
            gameName,
            uid,
            user.telegram_username || req.tg.name,
            it.wager,
            JSON.stringify({
              seed: activeSeed,
              commit: activeCommit,
              crashPoint: activeCp,
              auto: it.auto,
              roundId: activeRoundId,
              panelIndex: it.panelIndex
            }),
            flightStartEst
          ]
        );
      }
      await audit(c, uid, 'BET_TAKEOFF', total, bal, newBal, activeRoundId);
      return { ids, newBal, uname: user.telegram_username || req.tg.name };
    });

    if (mgr.room.roundId === activeRoundId && mgr.room.phase === 'WAITING') {
      items.forEach((it, idx) => {
        mgr.addQueuedBet({
          betId: out.ids[idx],
          userId: uid,
          username: out.uname,
          panelIndex: it.panelIndex,
          wager: it.wager,
          auto: it.auto
        });
      });
    }

    vaultAdd({ bal: total, wagered: total, profit: total });
    io.to(roomChannel(gameName)).emit('crash:bets', {
      game: gameName,
      roundId: activeRoundId,
      bets: mgr.getPublicBets()
    });
    io.to(userChannel(uid)).emit('crash:balance', { game: gameName, newBalance: out.newBal });

    return {
      success: true,
      roundId: activeRoundId,
      commit: activeCommit,
      betIds: out.ids,
      bets: items.map((it, idx) => ({ betId: out.ids[idx], panelIndex: it.panelIndex, wager: it.wager })),
      newBalance: out.newBal,
      growth: { a: math.CRASH_A, b: math.CRASH_B, c: math.CRASH_C }
    };
  }

  async function cancelRoomBet(req) {
    const betId = String(req.body?.betId || '').trim();
    if (!betId) throw new Biz('betId required');
    const uid = req.tg.id;

    let targetGame = null;
    let mgr = null;
    for (const [g, m] of rooms) {
      if (m.room.bets.some(b => b.betId === betId && b.userId === String(uid))) {
        targetGame = g;
        mgr = m;
        break;
      }
    }
    if (!mgr) throw new Biz('Bet not found in waiting round', 404);
    if (mgr.room.phase !== 'WAITING') throw new Biz('Cannot cancel after takeoff', 409);

    const removed = mgr.removeQueuedBet(betId, uid);
    if (!removed) throw new Biz('Bet already started or cancelled', 409);

    const out = await tx(async c => {
      const user = await lockUser(c, uid);
      const before = num(user.balance);
      const after = r2(before + removed.wager);
      await c.query(
        `UPDATE users SET balance=balance+$1,total_wagered=GREATEST(0,total_wagered-$1) WHERE user_id=$2`,
        [removed.wager, uid]
      );
      await c.query(`UPDATE universal_bets SET status='VOID',payout=$1 WHERE bet_id=$2`, [0, betId]);
      await audit(c, uid, 'BET_CANCEL', removed.wager, before, after, betId);
      return { newBalance: after };
    });

    vaultAdd({ bal: -removed.wager, wagered: -removed.wager, profit: -removed.wager });
    io.to(roomChannel(targetGame)).emit('crash:bets', {
      game: targetGame,
      roundId: mgr.room.roundId,
      bets: mgr.getPublicBets()
    });
    io.to(userChannel(uid)).emit('crash:balance', { game: targetGame, newBalance: out.newBalance });

    return { success: true, betId, newBalance: out.newBalance };
  }

  async function cashoutRoomBet(req) {
    const betId = String(req.body?.betId || '').trim();
    const clientMult = Number(req.body?.clientMult || 0);
    if (!betId) throw new Biz('betId required');
    const uid = req.tg.id;

    for (const [gameName, mgr] of rooms) {
      const found = mgr.room.bets.find(b => b.betId === betId && b.userId === String(uid));
      if (!found) continue;

      const settled = mgr.settleManualCashout(betId, uid, Date.now(), clientMult, CONFIG.MAX_PAYOUT);
      if (!settled.ok) {
        if (settled.reason === 'ALREADY_SETTLED' && settled.bet.status === 'WON') {
          const r = await pool.query('SELECT balance FROM users WHERE user_id=$1', [uid]);
          return {
            success: true,
            state: 'WON',
            multiplier: settled.bet.multiplier,
            payout: settled.bet.payout,
            newBalance: num(r.rows[0]?.balance)
          };
        }
        if (settled.reason === 'CRASHED') throw new Biz('Plane already crashed', 409);
        if (settled.reason === 'TOO_EARLY') throw new Biz('Too early to cash out');
        throw new Biz('Round is not flying', 409);
      }

      const out = await tx(async c => {
        const cur = await c.query('SELECT balance,telegram_username FROM users WHERE user_id=$1 FOR UPDATE', [uid]);
        const before = num(cur.rows[0].balance);
        const payout = settled.bet.payout;
        const after = r2(before + payout);
        await c.query('UPDATE users SET balance=$1,total_won=total_won+$2 WHERE user_id=$3', [after, payout, uid]);
        await c.query(
          `UPDATE universal_bets SET status=$1,multiplier=$2,payout=$3,house_profit=$4 WHERE bet_id=$5`,
          ['WON', settled.bet.multiplier, payout, r2(settled.bet.wager - payout), betId]
        );
        await audit(c, uid, 'CASHOUT_WIN', payout, before, after, betId);
        return { newBalance: after, uname: cur.rows[0].telegram_username };
      });

      vaultAdd({ bal: -settled.bet.payout, payouts: settled.bet.payout, profit: -settled.bet.payout });
      if (settled.bet.payout >= 500) {
        io.emit('live_win', { user: mask(out.uname), game: gameName, win: settled.bet.payout });
      }
      io.to(roomChannel(gameName)).emit('crash:cashout', { game: gameName, roundId: mgr.room.roundId, bet: settled.bet });
      io.to(roomChannel(gameName)).emit('crash:bets', {
        game: gameName,
        roundId: mgr.room.roundId,
        bets: mgr.getPublicBets()
      });
      io.to(userChannel(uid)).emit('crash:balance', { game: gameName, newBalance: out.newBalance });

      return {
        success: true,
        state: 'WON',
        multiplier: settled.bet.multiplier,
        payout: settled.bet.payout,
        newBalance: out.newBalance
      };
    }

    return null; // Not in a live room — caller falls back to legacy settleCrashRoute
  }

  function getRoomState(gameName, uid = null) {
    const mgr = rooms.get(gameName);
    if (!mgr) throw new Biz('Invalid game');
    return {
      success: true,
      ...mgr.getPublicSnapshot(Date.now()),
      myBets: formatMyBets(mgr, uid)
    };
  }

  return {
    rooms,
    seedHistories,
    placeRoomBet,
    cancelRoomBet,
    cashoutRoomBet,
    getRoomState
  };
}

module.exports = { createCrashEngine };
