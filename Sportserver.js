'use strict';
const express = require('express');

const MATCHES = [
  {
    id: 'UCL-ARS-RMA',
    sport: 'Soccer',
    league: 'UEFA Champions League',
    minute: "LIVE 68'",
    home: 'Arsenal FC',
    away: 'Real Madrid',
    score: '2 - 1',
    markets: [
      { key: '1', label: 'Arsenal Win', odds: 2.15 },
      { key: 'X', label: 'Draw', odds: 3.40 },
      { key: '2', label: 'Real Madrid Win', odds: 3.10 }
    ]
  },
  {
    id: 'EPL-STG-COF',
    sport: 'Soccer',
    league: 'Ethiopia Premier League',
    minute: "LIVE 36'",
    home: 'St. George SC',
    away: 'Ethiopian Coffee',
    score: '1 - 0',
    markets: [
      { key: '1', label: 'St. George Win', odds: 1.75 },
      { key: 'X', label: 'Draw', odds: 3.10 },
      { key: '2', label: 'Coffee SC Win', odds: 4.50 }
    ]
  },
  {
    id: 'NBA-LAL-BOS',
    sport: 'Basketball',
    league: 'NBA Regular Season',
    minute: 'LIVE Q3',
    home: 'LA Lakers',
    away: 'Boston Celtics',
    score: '82 - 79',
    markets: [
      { key: '1', label: 'Lakers Win', odds: 1.92 },
      { key: 'X', label: 'OT / Tie', odds: 9.50 },
      { key: '2', label: 'Celtics Win', odds: 2.05 }
    ]
  },
  {
    id: 'BOX-HW-TITLE',
    sport: 'Boxing',
    league: 'Heavyweight Championship',
    minute: 'ROUND 7',
    home: 'Anthony Joshua',
    away: 'Daniel Dubois',
    score: '67 - 66',
    markets: [
      { key: '1', label: 'Joshua Win', odds: 1.85 },
      { key: 'X', label: 'Draw', odds: 15.00 },
      { key: '2', label: 'Dubois Win', odds: 2.10 }
    ]
  }
];

function registerSportsbook(app, ctx) {
  const { pool, CONFIG, Biz, h, tx, audit, lockUser, newId, vaultAdd, userAuth, limit, r2, num } = ctx;
  const router = express.Router();

  router.get('/matches', (req, res) => {
    const sport = String(req.query.sport || '').trim();
    const list = sport && sport !== 'All'
      ? MATCHES.filter(m => m.sport.toLowerCase() === sport.toLowerCase())
      : MATCHES;
    res.json({ success: true, matches: list });
  });

  router.post('/bet', userAuth, limit('sportsbet', 60, 60e3), h(async (req, res) => {
    const { matchId, market } = req.body || {};
    const stake = r2(req.body?.stake);
    if (!Number.isFinite(stake) || stake < 20 || stake > CONFIG.MAX_BET) {
      throw new Biz(`Sports bet must be between 20 and ${CONFIG.MAX_BET} ETB`);
    }
    const fixture = MATCHES.find(m => m.id === matchId || `${m.home} vs ${m.away}` === req.body?.matchTitle);
    if (!fixture) throw new Biz('Match is no longer open for betting');
    const sel = fixture.markets.find(mk => mk.label === market || mk.key === market);
    if (!sel) throw new Biz('Invalid market selection');

    const potentialWin = Math.min(r2(stake * sel.odds), CONFIG.MAX_PAYOUT);
    const cashoutVal = r2(stake * 0.92);
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
          status: 'IN_PLAY',
          createdAt: new Date().toISOString()
        }
      };
    });

    vaultAdd({ bal: stake, wagered: stake, profit: stake });
    res.json({ success: true, newBalance: out.newBal, ticket: out.ticket });
  }));

  router.get('/my-bets', userAuth, limit('sportslist', 120, 60e3), h(async (req, res) => {
    const r = await pool.query(`SELECT * FROM sports_bets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40`, [req.tg.id]);
    res.json({
      success: true,
      bets: r.rows.map(b => ({
        id: b.ticket_id || b.bet_id,
        matchId: b.match_id,
        match: b.match_title,
        market: b.market,
        odds: num(b.odds),
        stake: num(b.stake),
        returnAmt: num(b.potential_win),
        cashoutVal: num(b.cashout_value),
        payout: num(b.payout),
        status: b.status,
        createdAt: b.created_at
      }))
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

      const cashVal = Math.min(r2(num(t.cashout_value)), CONFIG.MAX_PAYOUT);
      const u = await lockUser(c, uid);
      const before = num(u.balance);
      const after = r2(before + cashVal);

      await c.query('UPDATE users SET balance=$1,total_won=total_won+$2 WHERE user_id=$3', [after, cashVal, uid]);
      await c.query(`UPDATE sports_bets SET status='CASHED_OUT',payout=$1,settled_at=NOW() WHERE ticket_id=$2 OR bet_id=$2`, [cashVal, ticketId]);
      await audit(c, uid, 'SPORTS_CASHOUT', cashVal, before, after, ticketId);
      return { cashVal, after };
    });

    vaultAdd({ bal: -out.cashVal, payouts: out.cashVal, profit: -out.cashVal });
    res.json({ success: true, ticketId, payout: out.cashVal, newBalance: out.after });
  }));

  app.use('/api/sports', router);
  return { matches: MATCHES };
}

module.exports = { MATCHES, registerSportsbook };
