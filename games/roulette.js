'use strict';
const express = require('express');

module.exports = function createRouletteModule(ctx, shared) {
  const GAME_NAME = 'Roulette';
  const router = express.Router();

  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));

  return {
    name: GAME_NAME,
    slug: 'roulette',
    routePath: '/Roulette',
    htmlFile: 'routtet.html',
    type: 'instant',
    router
  };
};
