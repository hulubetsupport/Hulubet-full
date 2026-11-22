'use strict';
const express = require('express');
const math = require('../lib/game-math');

module.exports = function createChickenRoadModule(ctx, shared) {
  const GAME_NAME = 'ChickenRoad2';
  const router = express.Router();

  router.get('/config', (_req, res) => {
    res.json({ success: true, game: GAME_NAME, tables: math.CHICKEN_INSTANT.ChickenRoad2 });
  });

  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));

  return {
    name: GAME_NAME,
    slug: 'chicken-road',
    routePath: '/Chekn-road',
    htmlFile: 'Cheknroad.html',
    type: 'instant',
    router
  };
};
