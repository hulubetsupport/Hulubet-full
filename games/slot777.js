'use strict';
const express = require('express');
const math = require('../lib/game-math');

module.exports = function createSlot777Module(ctx, shared) {
  const GAME_NAME = 'Slot777';
  const router = express.Router();

  const paytableHandler = (_req, res) => {
    const t = math.slotTable(ctx.CONFIG.TARGET_RTP);
    res.json({
      success: true,
      game: GAME_NAME,
      symbols: math.SLOT.ids.map((id, i) => ({ id, weight: math.SLOT.w[i], triple: t.triple[i], pair: t.pair[i] })),
      colMult: math.SLOT.col.map(([m, p]) => ({ mult: m, chance: p })),
      hitRate: Math.round(t.hit * 1000) / 10
    });
  };

  router.get('/paytable', paytableHandler);
  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));

  return {
    name: GAME_NAME,
    slug: 'slot777',
    routePath: '/Slot-777-',
    htmlFile: 'slot777.html',
    type: 'instant',
    router,
    paytableHandler
  };
};
