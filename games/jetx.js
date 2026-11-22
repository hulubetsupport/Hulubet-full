'use strict';

module.exports = function createJetXModule(ctx, shared) {
  const GAME_NAME = 'JetX';
  const router = shared.createCrashRouter(GAME_NAME);
  return {
    name: GAME_NAME,
    slug: 'jetx',
    routePath: '/Jet-x',
    htmlFile: 'jetx.html',
    type: 'crash',
    router
  };
};
