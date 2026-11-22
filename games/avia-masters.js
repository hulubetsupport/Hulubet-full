'use strict';
const express = require('express');

module.exports = function createAviaMastersModule(ctx, shared) {
  const GAME_NAME = 'AviaMasters';
  const router = express.Router();

  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));

  return {
    name: GAME_NAME,
    slug: 'avia-masters',
    routePath: '/Avia-master',
    htmlFile: 'Aviamaster.html',
    type: 'instant',
    router
  };
};
