'use strict';
const math = require('../lib/game-math');
const { createStepGameModule } = require('./step-engine');

module.exports = function createRoastedChickenModule(ctx, shared) {
  return createStepGameModule(ctx, shared, {
    gameName: 'RoastedChicken',
    slug: 'roasted-chicken',
    routePath: '/Rosted-cheken',
    htmlFile: 'rostedchekin.html',
    tables: math.CHICKEN_INSTANT.RoastedChicken,
    tableKey: 'tables',
    defaultDifficulty: 'Easy',
    auditTag: 'CHICKEN_WIN',
    voidTag: 'CHICKEN_VOID'
  });
};
