'use strict';
const express = require('express');
const math = require('../lib/game-math');

module.exports = function createRoastedChickenModule(ctx, shared) {
  const GAME_NAME = 'RoastedChicken';
  const router = express.Router();

  router.get('/config', (_req, res) => {
    res.json({ success: true, game: GAME_NAME, tables: math.CHICKEN_INSTANT.RoastedChicken });
  });

  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));

  return {
    name: GAME_NAME,
    slug: 'roasted-chicken',
    routePath: '/Rosted-cheken',
    htmlFile: 'rostedchekin.html',
    type: 'instant',
    router
  };
};
