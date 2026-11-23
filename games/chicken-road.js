'use strict';
const math = require('../lib/game-math');
const { createStepGameModule } = require('./step-engine');

module.exports = function createChickenRoadModule(ctx, shared) {
  return createStepGameModule(ctx, shared, {
    gameName: 'ChickenRoad2',
    slug: 'chicken-road',
    routePath: '/Chekn-road',
    htmlFile: 'Cheknroad.html',
    tables: math.CHICKEN_INSTANT.ChickenRoad2,
    tableKey: 'tables',
    defaultDifficulty: 'Easy',
    auditTag: 'CHICKEN_WIN',
    voidTag: 'CHICKEN_VOID'
  });
};
