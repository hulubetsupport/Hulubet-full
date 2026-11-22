'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockPool } = require('../mock-db');
const {
  TWELVE_HOURS_MS,
  aggregateBetsFor12hReport,
  runTwelveHourAuditAndPrune,
  getRetentionStats,
  getReports12h
} = require('./audit-rollup');

test('aggregateBetsFor12hReport summarizes only settled bets strictly older than cutoff', () => {
  const now = new Date('2026-05-01T12:00:00.000Z').getTime();
  const cutoff = now - TWELVE_HOURS_MS;
  const old1 = new Date(cutoff - 60_000).toISOString();
  const old2 = new Date(cutoff - 120_000).toISOString();
  const fresh = new Date(cutoff + 60_000).toISOString();

  const reports = aggregateBetsFor12hReport([
    { bet_id: 'b1', game_name: 'Aviator', user_id: 'u1', bet_amount: 100, payout: 0, status: 'LOST', created_at: old1 },
    { bet_id: 'b2', game_name: 'Aviator', user_id: 'u2', bet_amount: 50, payout: 80, status: 'WON', created_at: old2 },
    { bet_id: 'b3', game_name: 'Aviator', user_id: 'u3', bet_amount: 40, payout: 0, status: 'LOST', created_at: fresh },
    { bet_id: 'b4', game_name: 'JetX', user_id: 'u1', bet_amount: 200, payout: 0, status: 'IN_FLIGHT', created_at: old1 }
  ], cutoff);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].game_name, 'Aviator');
  assert.equal(reports[0].total_bets, 2);
  assert.equal(reports[0].won_bets, 1);
  assert.equal(reports[0].lost_bets, 1);
  assert.equal(reports[0].total_wagered, 150);
  assert.equal(reports[0].total_payout, 80);
  assert.equal(reports[0].net_profit, 70);
  assert.equal(reports[0].unique_players, 2);
});

test('runTwelveHourAuditAndPrune archives >12h casino & sports bets, closes stale IN_FLIGHT, and preserves <12h rows', async () => {
  const pool = createMockPool();
  const now = Date.now();
  const oldTs = new Date(now - TWELVE_HOURS_MS - 3600_000);
  const freshTs = new Date(now - 1800_000);

  // Seed casino bets (>12h settled, >12h abandoned IN_FLIGHT, <12h active/settled)
  pool._db.universal_bets.push(
    { bet_id: 'old-win', game_name: 'MegaBlock', user_id: 'u1', bet_amount: 100, payout: 150, status: 'WON', created_at: oldTs },
    { bet_id: 'old-flight', game_name: 'Aviator', user_id: 'u2', bet_amount: 50, payout: 0, status: 'IN_FLIGHT', created_at: oldTs },
    { bet_id: 'fresh-bet', game_name: 'MegaBlock', user_id: 'u1', bet_amount: 25, payout: 0, status: 'LOST', created_at: freshTs },
    { bet_id: 'fresh-flight', game_name: 'LuckyChicken', user_id: 'u3', bet_amount: 30, payout: 0, status: 'IN_FLIGHT', created_at: freshTs }
  );

  // Seed sports bets (>12h cashed out vs <12h open IN_PLAY)
  pool._db.sports_bets.push(
    { ticket_id: 'spt-old', user_id: 'u1', stake: 200, payout: 184, status: 'CASHED_OUT', created_at: oldTs },
    { ticket_id: 'spt-fresh', user_id: 'u2', stake: 100, payout: 0, status: 'IN_PLAY', created_at: freshTs }
  );

  // Seed balance audit logs (>12h vs <12h)
  pool._db.balance_audit_logs.push(
    { id: 1, user_id: 'u1', action_type: 'BET', amount: 100, created_at: oldTs },
    { id: 2, user_id: 'u1', action_type: 'WIN', amount: 150, created_at: oldTs },
    { id: 3, user_id: 'u1', action_type: 'BET', amount: 25, created_at: freshTs }
  );

  const summary = await runTwelveHourAuditAndPrune(pool, { nowMs: now, actor: 'TEST_AUDIT' });
  assert.equal(summary.success, true);
  assert.equal(summary.reportsCreated, 3); // MegaBlock, Aviator (from >12h IN_FLIGHT), Sportsbook
  assert.equal(summary.purgedBets, 3);     // old-win, old-flight, spt-old
  assert.equal(summary.purgedAuditLogs, 2);

  // Verify remaining active/recent rows in DB (<12h)
  assert.equal(pool._db.universal_bets.length, 2);
  assert.deepEqual(pool._db.universal_bets.map(b => b.bet_id).sort(), ['fresh-bet', 'fresh-flight']);
  assert.equal(pool._db.sports_bets.length, 1);
  assert.equal(pool._db.sports_bets[0].ticket_id, 'spt-fresh');
  assert.equal(pool._db.balance_audit_logs.length, 1);

  const stats = await getRetentionStats(pool);
  assert.equal(stats.activeBetsInDb, 2);
  assert.equal(stats.activeAuditLogsInDb, 1);
  assert.equal(stats.archived12hReports, 3);
  assert.equal(stats.retentionWindowHours, 12);

  const reports = await getReports12h(pool, 10);
  const sportsReport = reports.find(r => r.game === 'Sportsbook');
  assert.ok(sportsReport);
  assert.equal(sportsReport.wagered, 200);
  assert.equal(sportsReport.payout, 184);
  assert.equal(sportsReport.profit, 16);
});
