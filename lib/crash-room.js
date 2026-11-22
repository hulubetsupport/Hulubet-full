'use strict';

const math = require('./game-math');

const WAIT_MS = 6000;
const CRASH_PAUSE_MS = 3200;

function curveMultAt(elapsedSec) {
  const t = Math.max(0, Number(elapsedSec) || 0);
  const m = 1 + math.CRASH_A * t + math.CRASH_B * Math.pow(t, math.CRASH_C);
  return Math.floor(m * 100) / 100;
}

function maskPlayerName(name, uid) {
  const raw = String(name || '').trim();
  if (raw.length >= 2) return raw.slice(0, 2) + '***' + raw.slice(-1);
  const s = String(uid || '00');
  return 'u' + s.slice(-2) + '***';
}

function createRoomState(gameName, seedFactory) {
  const room = {
    gameName,
    phase: 'WAITING', // WAITING | FLYING | CRASHED
    roundId: '',
    seed: '',
    commit: '',
    crashPoint: 1.0,
    phaseStartedAt: 0,
    waitEndsAt: 0,
    flightStart: 0,
    currentMult: 1.0,
    bets: [], // { betId, userId, player, panelIndex, wager, auto, status: 'QUEUED'|'IN_FLIGHT'|'WON'|'LOST', multiplier, payout }
    history: [], // [{ roundId, crashPoint, serverSeed, commit }]
    players: new Map() // socketId -> { userId, name }
  };

  function startWaiting(now = Date.now()) {
    const generated = seedFactory(room.gameName);
    room.phase = 'WAITING';
    room.roundId = generated.roundId;
    room.seed = generated.seed;
    room.commit = generated.commit;
    room.crashPoint = generated.crashPoint;
    room.phaseStartedAt = now;
    room.waitEndsAt = now + WAIT_MS;
    room.flightStart = 0;
    room.currentMult = 1.0;
    room.bets = [];
    return getPublicSnapshot(now);
  }

  function addQueuedBet(entry) {
    if (room.phase !== 'WAITING') return false;
    room.bets.push({
      betId: entry.betId,
      userId: String(entry.userId),
      player: maskPlayerName(entry.username, entry.userId),
      panelIndex: Number.isInteger(entry.panelIndex) ? entry.panelIndex : 0,
      wager: math.r2(entry.wager),
      auto: entry.auto ? math.r2(entry.auto) : null,
      status: 'QUEUED',
      multiplier: 0,
      payout: 0
    });
    return true;
  }

  function removeQueuedBet(betId, userId) {
    if (room.phase !== 'WAITING') return null;
    const idx = room.bets.findIndex(b => b.betId === betId && b.userId === String(userId) && b.status === 'QUEUED');
    if (idx === -1) return null;
    const [removed] = room.bets.splice(idx, 1);
    return removed;
  }

  function takeoff(now = Date.now()) {
    if (room.phase !== 'WAITING') return null;
    room.phase = 'FLYING';
    room.phaseStartedAt = now;
    room.flightStart = now;
    room.currentMult = 1.0;
    for (const b of room.bets) {
      if (b.status === 'QUEUED') b.status = 'IN_FLIGHT';
    }
    return getPublicSnapshot(now);
  }

  function stepTick(now = Date.now(), maxPayout = 20000) {
    if (room.phase === 'WAITING') {
      if (now >= room.waitEndsAt) {
        return { event: 'TAKEOFF', snapshot: takeoff(now) };
      }
      return { event: 'NONE' };
    }

    if (room.phase === 'CRASHED') {
      if (now - room.phaseStartedAt >= CRASH_PAUSE_MS) {
        return { event: 'NEW_ROUND', snapshot: startWaiting(now) };
      }
      return { event: 'NONE' };
    }

    // FLYING
    const elapsedSec = Math.max(0, (now - room.flightStart) / 1000);
    const mult = curveMultAt(elapsedSec);
    room.currentMult = mult;

    const autoWins = [];
    for (const b of room.bets) {
      if (b.status === 'IN_FLIGHT' && b.auto && b.auto <= room.crashPoint && mult >= b.auto) {
        const winMult = b.auto;
        const payout = Math.min(math.r2(b.wager * winMult), maxPayout);
        b.status = 'WON';
        b.multiplier = winMult;
        b.payout = payout;
        autoWins.push({ ...b });
      }
    }

    if (mult >= room.crashPoint) {
      const crashedList = [];
      for (const b of room.bets) {
        if (b.status === 'IN_FLIGHT') {
          b.status = 'LOST';
          b.multiplier = 0;
          b.payout = 0;
          crashedList.push({ ...b });
        }
      }
      room.phase = 'CRASHED';
      room.phaseStartedAt = now;
      room.currentMult = room.crashPoint;
      room.history.unshift({
        roundId: room.roundId,
        crashPoint: room.crashPoint,
        serverSeed: room.seed,
        commit: room.commit
      });
      if (room.history.length > 30) room.history.length = 30;
      return {
        event: 'CRASHED',
        autoWins,
        crashedBets: crashedList,
        snapshot: getPublicSnapshot(now)
      };
    }

    return {
      event: 'TICK',
      mult,
      elapsedMs: now - room.flightStart,
      autoWins
    };
  }

  function settleManualCashout(betId, userId, now = Date.now(), clientMult = 0, maxPayout = 20000) {
    if (room.phase !== 'FLYING') return { ok: false, reason: 'ROUND_NOT_FLYING' };
    const b = room.bets.find(x => x.betId === betId && x.userId === String(userId));
    if (!b) return { ok: false, reason: 'NOT_FOUND' };
    if (b.status !== 'IN_FLIGHT') return { ok: false, reason: 'ALREADY_SETTLED', bet: { ...b } };

    const elapsedSec = Math.max(0, (now - room.flightStart) / 1000);
    const d = math.decideCrash({
      cp: room.crashPoint,
      auto: b.auto,
      el: elapsedSec,
      cashout: true,
      clientMult
    });

    if (d.state === 'EARLY') return { ok: false, reason: 'TOO_EARLY' };
    if (d.state === 'CRASHED') return { ok: false, reason: 'CRASHED' };

    const mult = d.mult;
    const payout = Math.min(math.r2(b.wager * mult), maxPayout);
    b.status = 'WON';
    b.multiplier = mult;
    b.payout = payout;
    return { ok: true, bet: { ...b } };
  }

  function getPublicBets() {
    return room.bets.map(b => ({
      betId: b.betId,
      userId: b.userId,
      player: b.player,
      panelIndex: b.panelIndex,
      wager: b.wager,
      status: b.status,
      multiplier: b.multiplier,
      payout: b.payout
    }));
  }

  function getPublicSnapshot(now = Date.now()) {
    const snap = {
      game: room.gameName,
      phase: room.phase,
      roundId: room.roundId,
      commit: room.commit,
      serverNow: now,
      serverTime: now,
      waitMs: WAIT_MS,
      waitRemainingMs: room.phase === 'WAITING' ? Math.max(0, room.waitEndsAt - now) : 0,
      waitEndsAt: room.phase === 'WAITING' ? room.waitEndsAt : 0,
      flightStart: room.flightStart,
      elapsedMs: room.phase === 'FLYING' ? Math.max(0, now - room.flightStart) : 0,
      mult: room.phase === 'CRASHED' ? room.crashPoint : (room.phase === 'FLYING' ? room.currentMult : 1.0),
      playersCount: Math.max(1, room.players.size),
      growth: { a: math.CRASH_A, b: math.CRASH_B, c: math.CRASH_C },
      bets: getPublicBets(),
      history: room.history.slice(0, 20).map(h => ({
        roundId: h.roundId,
        crashPoint: h.crashPoint
      }))
    };
    // Reveal crashPoint & serverSeed ONLY after the round is CRASHED
    if (room.phase === 'CRASHED') {
      snap.crashPoint = room.crashPoint;
      snap.serverSeed = room.seed;
    }
    return snap;
  }

  return {
    WAIT_MS,
    CRASH_PAUSE_MS,
    room,
    startWaiting,
    addQueuedBet,
    removeQueuedBet,
    takeoff,
    stepTick,
    settleManualCashout,
    getPublicBets,
    getPublicSnapshot
  };
}

module.exports = {
  WAIT_MS,
  CRASH_PAUSE_MS,
  curveMultAt,
  maskPlayerName,
  createRoomState
};
