'use strict';
const math = require('../lib/game-math');
const { createStepGameModule } = require('./step-engine');

module.exports = function createMegaBlockModule(ctx, shared) {
  return createStepGameModule(ctx, shared, {
    gameName: 'MegaBlock',
    slug: 'mega-block',
    routePath: '/Mega-block',
    htmlFile: 'megablok.html',
    tables: math.MEGA_LADDERS,
    tableKey: 'ladders',
    defaultDifficulty: 'EASY',
    auditTag: 'MEGABLOCK_WIN',
    voidTag: 'MEGABLOCK_VOID'
  });
};
