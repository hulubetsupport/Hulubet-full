'use strict';
const path = require('path');
const { createSharedHelpers } = require('./shared');

const MODULES = [
  require('./aviator'),
  require('./jetx'),
  require('./keno-fast'),
  require('./classic-keno'),
  require('./chicken-road'),
  require('./lucky-chicken'),
  require('./roasted-chicken'),
  require('./slot777'),
  require('./avia-masters'),
  require('./plinko'),
  require('./roulette'),
  require('./mega-block')
];

const INSTANT_GAMES = [
  'KenoFast', 'ClassicKeno', 'Slot777', 'AviaMasters', 'PlinkoX',
  'Roulette', 'ChickenRoad2', 'RoastedChicken', 'MegaBlock'
];
const CRASH_GAMES = ['Aviator', 'JetX'];

function mountAllGames(app, ctx, rootDir) {
  const shared = createSharedHelpers(ctx);
  const registry = MODULES.map(fn => fn(ctx, shared));
  const byName = new Map(registry.map(m => [m.name, m]));

  // Serve each game HTML cleanly from the single repository + mount dedicated API router /api/games/<slug>/*
  for (const mod of registry) {
    app.get([mod.routePath, mod.routePath + '/', '/' + mod.htmlFile], (_req, res) => {
      res.sendFile(path.join(rootDir, mod.htmlFile));
    });
    app.use('/api/games/' + mod.slug, mod.router);
  }

  // Registry metadata endpoint
  app.get('/api/games', (_req, res) => {
    res.json({
      success: true,
      count: registry.length,
      games: registry.map(m => ({
        name: m.name,
        slug: m.slug,
        type: m.type,
        route: m.routePath + '/',
        apiBase: '/api/games/' + m.slug
      }))
    });
  });

  // Legacy unified routes (used by existing HTML game clients) delegated to game modules
  const kenoMod = byName.get('KenoFast');
  const slotMod = byName.get('Slot777');
  const plinkoMod = byName.get('PlinkoX');
  const chickenMod = byName.get('LuckyChicken');

  app.get('/api/slot/paytable', slotMod.paytableHandler);
  app.get('/api/plinko/paytable', plinkoMod.paytableHandler);
  app.get('/api/keno/paytable', kenoMod.paytableHandler);
  app.get('/api/keno/round/current', (_req, res) => res.json({ success: true, serverTime: Date.now() }));
  app.get('/api/keno/results', kenoMod.resultsHandler);

  app.get('/api/chicken/config', chickenMod.handlers.configHandler);
  app.post('/api/chicken/start', ctx.userAuth, ctx.limit('chicken', 120, 60e3), chickenMod.handlers.startHandler);
  app.get('/api/chicken/active', ctx.userAuth, ctx.limit('chickenstep', 300, 60e3), chickenMod.handlers.activeHandler);
  app.post('/api/chicken/step', ctx.userAuth, ctx.limit('chickenstep', 300, 60e3), chickenMod.handlers.stepHandler);
  app.post('/api/chicken/cashout', ctx.userAuth, ctx.limit('chickenstep', 300, 60e3), chickenMod.handlers.cashoutHandler);

  app.post('/api/bet/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    const { gameName } = req.body || {};
    if (CRASH_GAMES.includes(gameName)) throw new ctx.Biz('Use /api/crash/bet for this game');
    if (!INSTANT_GAMES.includes(gameName)) throw new ctx.Biz('Invalid game');
    res.json(await shared.processInstantBet(req, gameName));
  }));

  app.post('/api/crash/bet', ctx.userAuth, ctx.limit('crash', 120, 60e3), ctx.h(async (req, res) => {
    const { gameName, roundId } = req.body || {};
    if (roundId) return res.json(await shared.crashEngine.placeRoomBet(req, gameName));
    res.json(await shared.placeCrashBets(req, gameName));
  }));
  app.post('/api/crash/cancel', ctx.userAuth, ctx.limit('crash', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.crashEngine.cancelRoomBet(req));
  }));
  app.get('/api/crash/room', ctx.limit('feed', 120, 60e3), ctx.h(async (req, res) => {
    const gameName = req.query.game === 'JetX' ? 'JetX' : 'Aviator';
    const auth = ctx.parseInitData ? ctx.parseInitData(req.headers['x-telegram-init-data'] || req.query?.initData) : null;
    res.json(shared.crashEngine.getRoomState(gameName, auth?.id || null));
  }));
  app.get('/api/crash/status', ctx.userAuth, ctx.limit('crashstat', 600, 60e3), ctx.h((req, res) => shared.settleCrashRoute(req, res, false)));
  app.post('/api/crash/cashout', ctx.userAuth, ctx.limit('crash', 120, 60e3), ctx.h((req, res) => shared.settleCrashRoute(req, res, true)));

  return { registry, shared, chickenMod };
}

module.exports = { mountAllGames, INSTANT_GAMES, CRASH_GAMES };
