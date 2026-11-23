'use strict';
const express = require('express');
const crypto = require('crypto');
const {
  createDefaultFixtures,
  createReplacementFixture,
  hydrateFixture,
  tickMatch,
  evaluateMarketResult,
  computeCashoutValue
} = require('./lib/sports-engine');

const SETTINGS_KEY = 'sports_fixtures_state';

function registerSportsbook(app, ctx) {
  const {
    pool, io, CONFIG, Biz, h, tx, audit, lockUser,
    newId, vaultAdd, userAuth, admin, alog, notify, limit, r2, num, cacheInvalidate
  } = ctx;

  let fixtures = createDefaultFixtures();
  let seqCounter = 1;
  let settling = new Set();
  let dirty = false;
  let lastPersistedAt = 0;
  let tickTimer = null;
  const PERSIST_INTERVAL_MS = 120000; // Persist routine clock ticks at most every 2 minutes (or immediately on FT/admin changes)

  async function persistFixtures() {
    try {
      const payload = JSON.stringify(fixtures);
      await pool.query(
        `INSERT INTO system_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`,
        [SETTINGS_KEY, payload]
      );
      dirty = false;
      lastPersistedAt = Date.now();
    } catch (_) {}
  }

  async function persistIfDirty(force = false) {
    if (!dirty) return;
    if (force || Date.now() - lastPersistedAt >= PERSIST_INTERVAL_MS) {
      await persistFixtures();
    }
  }

  async function restoreFixtures() {
    try {
      const r = await pool.query(`SELECT value FROM system_settings WHERE key=$1`, [SETTINGS_KEY]);
      if (r.rows.length && r.rows[0].value) {
        const parsed = JSON.parse(r.rows[0].value);
        if (Array.isArray(parsed) && parsed.length) {
          fixtures = parsed.map(hydrateFixture);
          dirty = false;
          lastPersistedAt = Date.now();
          return;
        }
      }
    } catch (_) {}
    fixtures = createDefaultFixtures();
    await persistFixtures();
  }

  function findFixture(matchId, matchTitle) {
    return fixtures.find(
      m => m.id === matchId || (matchTitle && `${m.home} vs ${m.away}` === matchTitle)
    );
  }

  function broadcastUpdate() {
    if (io && io.engine && io.engine.clientsCount > 0) {
      io.emit('sports:update', { matches: fixtures });
    }
  }

  async function settleFixture(matchId, actor = 'AUTO_FT', overrideScores = null) {
    if (settling.has(matchId)) return { settledCount: 0, totalPayout: 0, alreadyRunning: true };
    settling.add(matchId);
    try {
      let fx = fixtures.find(m => m.id === matchId);
      if (!fx) {
        // Fallback stub fixture for historical bets no longer in active list
        fx = hydrateFixture({
          id: matchId,
          sport: 'Soccer',
          home: overrideScores?.home || '',
          away: overrideScores?.away || '',
          homeScore: Number(overrideScores?.homeScore ?? 0),
          awayScore: Number(overrideScores?.awayScore ?? 0),
          progress: 1,
          status: 'FT'
        });
      } else {
        if (overrideScores) {
          if (overrideScores.homeScore !== undefined) fx.homeScore = Math.max(0, parseInt(overrideScores.homeScore, 10) || 0);
          if (overrideScores.awayScore !== undefined) fx.awayScore = Math.max(0, parseInt(overrideScores.awayScore, 10) || 0);
        }
        fx.progress = 1;
        fx.status = 'FT';
        fx.finishedAt = fx.finishedAt || Date.now();
        fx = hydrateFixture(fx);
        const idx = fixtures.findIndex(m => m.id === matchId);
        if (idx >= 0) fixtures[idx] = fx;
      }

      const out = await tx(async c => {
        const rows = (await c.query(
          `SELECT * FROM sports_bets WHERE match_id=$1 AND status='IN_PLAY' FOR UPDATE`,
          [matchId]
        )).rows;

        let settledCount = 0;
        let wonCount = 0;
        let totalPayout = 0;
        const notices = [];

        for (const t of rows) {
          const tid = t.ticket_id || t.bet_id;
          const isWin = evaluateMarketResult(t.market, fx);
          if (isWin) {
            const payout = Math.min(r2(num(t.potential_win)), CONFIG.MAX_PAYOUT);
            const u = await c.query('SELECT balance FROM users WHERE user_id=$1 FOR UPDATE', [t.user_id]);
            if (u.rows.length) {
              const before = num(u.rows[0].balance);
              const after = r2(before + payout);
              await c.query('UPDATE users SET balance=$1,total_won=total_won+$2 WHERE user_id=$3', [after, payout, t.user_id]);
              await audit(c, t.user_id, 'SPORTS_WIN', payout, before, after, tid);
            }
            await c.query(
              `UPDATE sports_bets SET status='WON',payout=$1,settled_at=NOW() WHERE (ticket_id=$2 OR bet_id=$2) AND status='IN_PLAY'`,
              [payout, tid]
            );
            wonCount++;
            totalPayout = r2(totalPayout + payout);
            notices.push({ uid: t.user_id, text: `🏆 Sports Bet WON! #${tid}\n${t.match_title} (${fx.score})\nPick: ${t.market}\nPayout: +${payout.toFixed(2)} ETB` });
          } else {
            await c.query(
              `UPDATE sports_bets SET status='LOST',payout=0,settled_at=NOW() WHERE (ticket_id=$1 OR bet_id=$1) AND status='IN_PLAY'`,
              [tid]
            );
            notices.push({ uid: t.user_id, text: `Ticket #${tid} settled (${fx.score} FT) — ${t.match_title}: Lost.` });
          }
          settledCount++;
        }
        return { settledCount, wonCount, totalPayout, notices };
      });

      if (out.totalPayout > 0) {
        vaultAdd({ bal: -out.totalPayout, payouts: out.totalPayout, profit: -out.totalPayout });
      }
      await persistFixtures();
      if (cacheInvalidate) cacheInvalidate('admin:dashboard');
      broadcastUpdate();
      if (io) {
        io.emit('sports:settled', {
          matchId,
          score: fx.score,
          settledCount: out.settledCount,
          wonCount: out.wonCount,
          totalPayout: out.totalPayout
        });
      }
      if (typeof notify === 'function') {
        for (const n of out.notices.slice(0, 50)) {
          notify(n.uid, n.text);
        }
      }
      return { ...out, fixture: fx, actor };
    } finally {
      settling.delete(matchId);
    }
  }

  // Live progression timer (started after DB schema/restore; DB writes batched every 2m unless FT/rotated)
  function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(async () => {
      try {
        const now = Date.now();
        const finishedIds = [];
        let changed = false;
        let urgentPersist = false;

        fixtures = fixtures.map(f => {
          if (f.status === 'LIVE') {
            const next = tickMatch(f);
            changed = true;
            if (next.status === 'FT') {
              finishedIds.push(next.id);
              urgentPersist = true;
            }
            return next;
          }
          if (f.status === 'FT' && f.finishedAt && now - f.finishedAt > 90 * 1000) {
            changed = true;
            urgentPersist = true;
            return createReplacementFixture(f.sport, seqCounter++, now);
          }
          return f;
        });

        for (const mid of finishedIds) {
          await settleFixture(mid, 'AUTO_FT').catch(e => console.error('sports auto-settle:', e.message));
        }

        if (changed) {
          dirty = true;
          await persistIfDirty(urgentPersist);
          broadcastUpdate();
        }
      } catch (e) {
        console.error('sports tick:', e.message);
      }
    }, 20000);
    tickTimer.unref();
  }

  // ---- Player Routes (/api/sports/*) ----
  const router = express.Router();

  router.get('/matches', (req, res) => {
    const sport = String(req.query.sport || '').trim();
    const list = sport && sport !== 'All'
      ? fixtures.filter(m => m.sport.toLowerCase() === sport.toLowerCase())
      : fixtures;
    res.json({ success: true, matches: list });
  });

  router.post('/bet', userAuth, limit('sportsbet', 60, 60e3), h(async (req, res) => {
    const { matchId, market } = req.body || {};
    const stake = r2(req.body?.stake);
    if (!Number.isFinite(stake) || stake < 20 || stake > CONFIG.MAX_BET) {
      throw new Biz(`Sports bet must be between 20 and ${CONFIG.MAX_BET} ETB`);
    }
    const fixture = findFixture(matchId, req.body?.matchTitle);
    if (!fixture || fixture.status !== 'LIVE') {
      throw new Biz('Match is no longer open for live betting');
    }
    const sel = fixture.markets.find(
      mk => mk.label.toLowerCase() === String(market || '').trim().toLowerCase() ||
            mk.key.toLowerCase() === String(market || '').trim().toLowerCase()
    );
    if (!sel) throw new Biz('Invalid market selection');

    const potentialWin = Math.min(r2(stake * sel.odds), CONFIG.MAX_PAYOUT);
    const cashoutVal = computeCashoutValue({ stake, potential_win: potentialWin, market: sel.label }, fixture);
    const ticketId = newId('SPT');
    const matchTitle = `${fixture.home} vs ${fixture.away}`;
    const uid = req.tg.id;

    const out = await tx(async c => {
      const u = await lockUser(c, uid);
      const bal = num(u.balance);
      if (bal < stake) throw new Biz('Insufficient balance');
      const newBal = r2(bal - stake);
      await c.query(
        `UPDATE users SET balance=$1,total_wagered=total_wagered+$2,
         wager_requirement_left=GREATEST(0,COALESCE(wager_requirement_left,0)-$2),last_active_at=NOW() WHERE user_id=$3`,
        [newBal, stake, uid]
      );
      await c.query(
        `INSERT INTO sports_bets (ticket_id,bet_id,user_id,username,match_id,match_title,market,odds,stake,potential_win,cashout_value,status)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'IN_PLAY')`,
        [ticketId, uid, u.telegram_username, fixture.id, matchTitle, sel.label, sel.odds, stake, potentialWin, cashoutVal]
      );
      await audit(c, uid, 'SPORTS_BET', stake, bal, newBal, ticketId);
      return {
        newBal,
        ticket: {
          id: ticketId,
          matchId: fixture.id,
          match: matchTitle,
          market: sel.label,
          odds: sel.odds,
          stake,
          returnAmt: potentialWin,
          cashoutVal,
          payout: 0,
          status: 'IN_PLAY',
          matchScore: fixture.score,
          matchMinute: fixture.minute,
          createdAt: new Date().toISOString()
        }
      };
    });

    vaultAdd({ bal: stake, wagered: stake, profit: stake });
    if (cacheInvalidate) cacheInvalidate('admin:dashboard');
    res.json({ success: true, newBalance: out.newBal, ticket: out.ticket });
  }));

  router.get('/my-bets', userAuth, limit('sportslist', 120, 60e3), h(async (req, res) => {
    const r = await pool.query(`SELECT * FROM sports_bets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40`, [req.tg.id]);
    res.json({
      success: true,
      bets: r.rows.map(b => {
        const fx = fixtures.find(m => m.id === b.match_id);
        const liveCashout = b.status === 'IN_PLAY'
          ? computeCashoutValue(b, fx)
          : num(b.cashout_value);
        return {
          id: b.ticket_id || b.bet_id,
          matchId: b.match_id,
          match: b.match_title,
          market: b.market,
          odds: num(b.odds),
          stake: num(b.stake),
          returnAmt: num(b.potential_win),
          cashoutVal: liveCashout,
          payout: num(b.payout),
          status: b.status,
          matchScore: fx ? fx.score : null,
          matchMinute: fx ? fx.minute : 'FT',
          createdAt: b.created_at
        };
      })
    });
  }));

  router.post('/cashout', userAuth, limit('sportscash', 60, 60e3), h(async (req, res) => {
    const ticketId = String(req.body?.ticketId || '');
    if (!ticketId) throw new Biz('ticketId required');
    const uid = req.tg.id;

    const out = await tx(async c => {
      const r = await c.query(`SELECT * FROM sports_bets WHERE (ticket_id=$1 OR bet_id=$1) AND user_id=$2 FOR UPDATE`, [ticketId, uid]);
      if (!r.rows.length) throw new Biz('Ticket not found', 404);
      const t = r.rows[0];
      if (t.status !== 'IN_PLAY') throw new Biz('Ticket already settled');

      const fx = fixtures.find(m => m.id === t.match_id);
      if (fx && fx.status !== 'LIVE') {
        throw new Biz('Match already finished; awaiting final settlement');
      }

      const computedCash = computeCashoutValue(t, fx);
      const cashVal = Math.min(r2(computedCash), CONFIG.MAX_PAYOUT);
      if (!(cashVal > 0)) {
        throw new Biz('Cashout is locked for this market outcome');
      }

      const u = await lockUser(c, uid);
      const before = num(u.balance);
      const after = r2(before + cashVal);

      await c.query('UPDATE users SET balance=$1,total_won=total_won+$2 WHERE user_id=$3', [after, cashVal, uid]);
      await c.query(
        `UPDATE sports_bets SET status='CASHED_OUT',payout=$1,cashout_value=$1,settled_at=NOW() WHERE ticket_id=$2 OR bet_id=$2`,
        [cashVal, ticketId]
      );
      await audit(c, uid, 'SPORTS_CASHOUT', cashVal, before, after, ticketId);
      return { cashVal, after };
    });

    vaultAdd({ bal: -out.cashVal, payouts: out.cashVal, profit: -out.cashVal });
    if (cacheInvalidate) cacheInvalidate('admin:dashboard');
    res.json({ success: true, ticketId, payout: out.cashVal, newBalance: out.after });
  }));

  app.use('/api/sports', router);

  // ---- Admin Routes (/api/admin/sports*) ----
  if (Array.isArray(admin)) {
    app.get('/api/admin/sports', admin, h(async (_req, res) => {
      const open = await pool.query(`SELECT match_id,stake,potential_win FROM sports_bets WHERE status='IN_PLAY'`).catch(() => ({ rows: [] }));
      const statsByMatch = new Map();
      for (const row of open.rows) {
        const cur = statsByMatch.get(row.match_id) || { openTickets: 0, totalStaked: 0, maxLiability: 0 };
        cur.openTickets += 1;
        cur.totalStaked = r2(cur.totalStaked + num(row.stake));
        cur.maxLiability = r2(cur.maxLiability + num(row.potential_win));
        statsByMatch.set(row.match_id, cur);
      }
      res.json({
        success: true,
        matches: fixtures.map(f => ({
          ...f,
          ...(statsByMatch.get(f.id) || { openTickets: 0, totalStaked: 0, maxLiability: 0 })
        }))
      });
    }));

    app.post('/api/admin/sports/create', admin, h(async (req, res) => {
      const sport = ['Soccer', 'Basketball', 'Boxing'].includes(req.body?.sport) ? req.body.sport : 'Soccer';
      const league = String(req.body?.league || `${sport} Live League`).trim().slice(0, 60);
      const home = String(req.body?.home || '').trim().slice(0, 40);
      const away = String(req.body?.away || '').trim().slice(0, 40);
      if (!home || !away) throw new Biz('Home and away team names are required');

      const id = `${sport.slice(0, 3).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const fx = hydrateFixture({
        id,
        sport,
        league,
        home,
        away,
        homeScore: Math.max(0, parseInt(req.body?.homeScore || '0', 10) || 0),
        awayScore: Math.max(0, parseInt(req.body?.awayScore || '0', 10) || 0),
        progress: Math.min(0.95, Math.max(0.05, Number(req.body?.progress || 0.15))),
        status: 'LIVE',
        createdAt: Date.now()
      });
      fixtures.unshift(fx);
      await persistFixtures();
      broadcastUpdate();
      if (alog) alog(req, 'sports-create', `${fx.id} ${home} vs ${away}`);
      res.json({ success: true, match: fx, message: `Added ${home} vs ${away}` });
    }));

    app.post('/api/admin/sports/update', admin, h(async (req, res) => {
      const matchId = String(req.body?.matchId || '').trim();
      const idx = fixtures.findIndex(m => m.id === matchId);
      if (idx < 0) throw new Biz('Match not found', 404);
      const cur = { ...fixtures[idx] };
      if (req.body?.homeScore !== undefined) cur.homeScore = Math.max(0, parseInt(req.body.homeScore, 10) || 0);
      if (req.body?.awayScore !== undefined) cur.awayScore = Math.max(0, parseInt(req.body.awayScore, 10) || 0);
      if (req.body?.progress !== undefined) cur.progress = Math.min(0.99, Math.max(0.02, Number(req.body.progress) || cur.progress));
      fixtures[idx] = hydrateFixture(cur);
      await persistFixtures();
      broadcastUpdate();
      if (alog) alog(req, 'sports-update', `${matchId} -> ${fixtures[idx].score}`);
      res.json({ success: true, match: fixtures[idx], message: `Updated ${fixtures[idx].home} vs ${fixtures[idx].away} (${fixtures[idx].score})` });
    }));

    app.post('/api/admin/sports/settle', admin, h(async (req, res) => {
      const matchId = String(req.body?.matchId || '').trim();
      if (!matchId) throw new Biz('matchId required');
      const override = (req.body?.homeScore !== undefined || req.body?.awayScore !== undefined)
        ? { homeScore: req.body.homeScore, awayScore: req.body.awayScore, home: req.body.home, away: req.body.away }
        : null;
      const out = await settleFixture(matchId, req.actor || 'Admin', override);
      if (alog) alog(req, 'sports-settle', `${matchId} (${out.fixture.score}): settled=${out.settledCount}, won=${out.wonCount}, payout=${out.totalPayout}`);
      res.json({
        success: true,
        matchId,
        score: out.fixture.score,
        settledCount: out.settledCount,
        wonCount: out.wonCount,
        totalPayout: out.totalPayout,
        message: `Settled ${matchId} (${out.fixture.score}): ${out.settledCount} tickets (${out.wonCount} won, ${out.totalPayout.toFixed(2)} ETB paid)`
      });
    }));
  }

  return {
    getFixtures: () => fixtures,
    settleFixture,
    restoreFixtures,
    startTick,
    persistIfDirty
  };
}

module.exports = { registerSportsbook };
