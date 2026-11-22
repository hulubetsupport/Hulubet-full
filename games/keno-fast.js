'use strict';
const express = require('express');
const math = require('../lib/game-math');

module.exports = function createKenoFastModule(ctx, shared) {
  const GAME_NAME = 'KenoFast';
  const router = express.Router();

  const paytableHandler = (_req, res) => {
    const t = {};
    for (let k = 1; k <= 10; k++) t[k] = math.kenoTable(k, ctx.CONFIG.KENO_RTP);
    res.json({ success: true, game: GAME_NAME, paytable: t });
  };

  const resultsHandler = ctx.h(async (req, res) => {
    const lim = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
    const r = await ctx.pool.query(
      `SELECT game_data, created_at FROM universal_bets WHERE game_name=$1 AND status IN ('WON','LOST') ORDER BY created_at DESC LIMIT $2`,
      [GAME_NAME, lim]
    );
    const results = r.rows.map((row, idx) => {
      const gd = ctx.parseJson(row.game_data);
      return { round: r.rows.length - idx, drawnNumbers: gd.drawnNumbers || [], createdAt: row.created_at };
    });
    res.json({ success: true, results });
  });

  router.get('/paytable', paytableHandler);
  router.get('/round/current', (_req, res) => res.json({ success: true, serverTime: Date.now() }));
  router.get('/results', resultsHandler);
  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));

  return {
    name: GAME_NAME,
    slug: 'keno-fast',
    routePath: '/Keno-fast',
    htmlFile: 'Fastkeno.html',
    type: 'instant',
    router,
    paytableHandler,
    resultsHandler
  };
};
