'use strict';
const express = require('express');
const math = require('../lib/game-math');

module.exports = function createClassicKenoModule(ctx, shared) {
  const GAME_NAME = 'ClassicKeno';
  const router = express.Router();

  router.get('/paytable', (_req, res) => {
    const t = {};
    for (let k = 1; k <= 10; k++) t[k] = math.kenoTable(k, ctx.CONFIG.KENO_RTP);
    res.json({ success: true, game: GAME_NAME, paytable: t });
  });

  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));

  return {
    name: GAME_NAME,
    slug: 'classic-keno',
    routePath: '/Classic-Keno',
    htmlFile: 'Clasisckeno.html',
    type: 'instant',
    router
  };
};
