'use strict';
const express = require('express');
const math = require('../lib/game-math');

module.exports = function createMegaBlockModule(ctx, shared) {
  const GAME_NAME = 'MegaBlock';
  const router = express.Router();

  router.get('/config', (_req, res) => {
    res.json({ success: true, game: GAME_NAME, ladders: math.MEGA_LADDERS });
  });

  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));

  return {
    name: GAME_NAME,
    slug: 'mega-block',
    routePath: '/Mega-block',
    htmlFile: 'megablok.html',
    type: 'instant',
    router
  };
};
