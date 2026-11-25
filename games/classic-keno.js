'use strict';
const express = require('express');
const math = require('../lib/game-math');

module.exports = function createClassicKenoModule(ctx, shared) {
  const GAME_NAME = 'ClassicKeno';
  const router = express.Router();
  const kenoSecret = () => ctx.CONFIG.KENO_SECRET || process.env.ADMIN_PIN || 'hulu-keno-secret';

  const paytableHandler = (_req, res) => {
    const t = {};
    for (let k = 1; k <= 10; k++) t[k] = math.kenoTable(k, ctx.CONFIG.KENO_RTP);
    res.json({ success: true, game: GAME_NAME, paytable: t });
  };

  const roundCurrentHandler = (_req, res) => {
    const st = math.kenoCycleState(Date.now());
    const payload = {
      success: true,
      serverTime: st.serverTime,
      roundId: st.roundId,
      phase: st.phase,
      remainingSec: st.remainingSec,
      cycleSec: st.cycleSec,
      elapsedDrawSec: st.elapsedDrawSec
    };
    if (st.isDrawing) {
      payload.drawnNumbers = math.kenoDrawForRound(kenoSecret(), GAME_NAME, st.roundId);
    }
    res.json(payload);
  };

  const resultsHandler = ctx.h(async (req, res) => {
    const lim = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
    const load = async () => {
      const r = await ctx.pool.query(
        `SELECT game_data, created_at FROM universal_bets WHERE game_name=$1 AND status IN ('WON','LOST') ORDER BY created_at DESC LIMIT $2`,
        [GAME_NAME, lim * 4]
      );
      const seen = new Set();
      const items = [];
      for (const row of r.rows) {
        const gd = ctx.parseJson(row.game_data);
        const rid = gd.roundId ? Number(gd.roundId) : null;
        const key = rid !== null ? String(rid) : String(row.created_at);
        if (seen.has(key)) continue;
        seen.add(key);
        const drawnNumbers = Array.isArray(gd.drawnNumbers) && gd.drawnNumbers.length === 20
          ? gd.drawnNumbers
          : (rid !== null ? math.kenoDrawForRound(kenoSecret(), GAME_NAME, rid) : []);
        if (!drawnNumbers.length) continue;
        items.push({
          id: rid || (items.length + 1),
          round: rid || (items.length + 1),
          numbers: drawnNumbers,
          drawnNumbers,
          createdAt: row.created_at,
          time: new Date(row.created_at).getTime()
        });
        if (items.length >= lim) break;
      }
      const cur = math.kenoCycleState(Date.now());
      let prevRid = cur.roundId - 1;
      while (items.length < Math.min(12, lim)) {
        if (!seen.has(String(prevRid))) {
          seen.add(String(prevRid));
          const drawnNumbers = math.kenoDrawForRound(kenoSecret(), GAME_NAME, prevRid);
          const ts = cur.serverTime - ((cur.roundId - prevRid) * math.KENO_CYCLE.TOTAL_CYCLE * 1000);
          items.push({
            id: prevRid,
            round: prevRid,
            numbers: drawnNumbers,
            drawnNumbers,
            createdAt: new Date(ts).toISOString(),
            time: ts
          });
        }
        prevRid -= 1;
      }
      return items;
    };
    const results = ctx.cache ? await ctx.cache.getOrLoad(`classic_keno_results:${lim}`, 4000, load) : await load();
    res.json({ success: true, results });
  });

  router.get('/paytable', paytableHandler);
  router.get('/round/current', roundCurrentHandler);
  router.get('/results', resultsHandler);
  router.post('/play', ctx.userAuth, ctx.limit('bet', 120, 60e3), ctx.h(async (req, res) => {
    res.json(await shared.processInstantBet(req, GAME_NAME));
  }));

  return {
    name: GAME_NAME,
    slug: 'classic-keno',
    routePath: '/Classic-Keno',
    htmlFile: 'Clasisckeno.html',
    type: 'instant',
    router,
    paytableHandler,
    roundCurrentHandler,
    resultsHandler
  };
};
