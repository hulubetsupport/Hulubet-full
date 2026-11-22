'use strict';

module.exports = function createAviatorModule(ctx, shared) {
  const GAME_NAME = 'Aviator';
  const router = shared.createCrashRouter(GAME_NAME);
  return {
    name: GAME_NAME,
    slug: 'aviator',
    routePath: '/Aveiter',
    htmlFile: 'avatar.html',
    type: 'crash',
    router
  };
};
