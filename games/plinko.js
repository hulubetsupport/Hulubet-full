'use strict';
const express = require('express');
const math = require('../lib/game-math');

module.exports = function createPlinkoModule(ctx, shared) {
  const GAME_NAME = 'PlinkoX';
  const router = express.Router();

  const paytableHandler = (_req, res) => {
    const tables = {};
    Object.keys(math.PL_SHAPE).forEach(k => { tables[k] = math.plinkoTable(k, ctx.CONFIG.TARGET_RTP); });
    res.json({ success: true, game: GAME_NAME, rows: 16, ballCounts: math.PL_BALLS, tables });
  };

  router.get('/paytable', paytableHandler);
  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));

  return {
    name: GAME_NAME,
    slug: 'plinko',
    routePath: '/Plinkok',
    htmlFile: 'Pilinkok.html',
    type: 'instant',
    router,
    paytableHandler
  };
};
