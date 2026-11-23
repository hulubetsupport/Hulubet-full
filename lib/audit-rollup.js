'use strict';

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const r2 = n => Math.round(Number(n) * 100) / 100;
const num = v => parseFloat(v || 0) || 0;

/**
 * Pure aggregation function for 12-hour audit rollups (unit-tested).
 * Filters settled bets strictly older than cutoffMs and summarizes per game.
 */
function aggregateBetsFor12hReport(bets, cutoffMs) {
  const byGame = new Map();
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const b of bets) {
    if (!['WON', 'LOST', 'VOID'].includes(b.status)) continue;
    const ts = new Date(b.created_at).getTime();
    if (!Number.isFinite(ts) || ts >= cutoffMs) continue;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;

    const g = b.game_name || 'Unknown';
    let acc = byGame.get(g);
    if (!acc) {
      acc = {
        game_name: g,
        total_bets: 0,
        won_bets: 0,
        lost_bets: 0,
        total_wagered: 0,
        total_payout: 0,
        net_profit: 0,
        players: new Set()
      };
      byGame.set(g, acc);
    }
    acc.total_bets += 1;
    if (b.status === 'WON') acc.won_bets += 1;
    else if (b.status === 'LOST') acc.lost_bets += 1;
    const wager = num(b.bet_amount);
    const payout = num(b.payout);
    acc.total_wagered = r2(acc.total_wagered + wager);
    acc.total_payout = r2(acc.total_payout + payout);
    acc.net_profit = r2(acc.net_profit + (wager - payout));
    if (b.user_id) acc.players.add(String(b.user_id));
  }

  const reports = [];
  for (const acc of byGame.values()) {
    reports.push({
      period_start: new Date(minTs === Infinity ? cutoffMs - TWELVE_HOURS_MS : minTs),
      period_end: new Date(maxTs === -Infinity ? cutoffMs : maxTs),
      game_name: acc.game_name,
      total_bets: acc.total_bets,
      won_bets: acc.won_bets,
      lost_bets: acc.lost_bets,
      total_wagered: acc.total_wagered,
      total_payout: acc.total_payout,
      net_profit: acc.net_profit,
      actual_rtp: acc.total_wagered > 0 ? r2((acc.total_payout / acc.total_wagered) * 100) : 0,
      unique_players: acc.players.size
    });
  }
  return reports;
}

async function runTwelveHourAuditAndPrune(pool, opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const maxAgeMs = opts.maxAgeMs || TWELVE_HOURS_MS;
  const cutoff = new Date(nowMs - maxAgeMs);

  // Fast-path existence check: avoid acquiring a connection & opening a TX when nothing has aged past 12h
  const pre = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM universal_bets WHERE created_at < $1 LIMIT 1) AS has_bets,
            EXISTS(SELECT 1 FROM balance_audit_logs WHERE created_at < $1 LIMIT 1) AS has_audits,
            EXISTS(SELECT 1 FROM sports_bets WHERE created_at < $1 LIMIT 1) AS has_sports`,
    [cutoff]
  ).catch(() => null);
  if (pre && pre.rows && pre.rows[0]) {
    const r = pre.rows[0];
    if (!r.has_bets && !r.has_audits && !r.has_sports) {
      return {
        success: true,
        cutoff: cutoff.toISOString(),
        reportsCreated: 0,
        purgedBets: 0,
        purgedAuditLogs: 0,
        reports: []
      };
    }
  }

  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // Fetch settled bets older than 12h (also treat abandoned >12h IN_FLIGHT as VOID/stale cleanup)
    await c.query(
      `UPDATE universal_bets SET status='LOST', house_profit=bet_amount
       WHERE status='IN_FLIGHT' AND created_at < $1`,
      [cutoff]
    );

    const oldBets = await c.query(
      `SELECT bet_id, game_name, user_id, bet_amount, payout, status, created_at
       FROM universal_bets
       WHERE status IN ('WON', 'LOST', 'VOID') AND created_at < $1`,
      [cutoff]
    );

    const oldSports = await c.query(
      `SELECT COALESCE(ticket_id, bet_id) AS bet_id, 'Sportsbook' AS game_name, user_id, stake AS bet_amount, payout, status, created_at
       FROM sports_bets
       WHERE status IN ('WON','LOST','CASHED_OUT','VOID') AND created_at < $1`,
      [cutoff]
    ).catch(() => ({ rows: [] }));

    const normalizedSports = (oldSports.rows || []).map(s => ({
      ...s,
      status: s.status === 'CASHED_OUT' ? 'WON' : s.status
    }));

    const reports = aggregateBetsFor12hReport([...oldBets.rows, ...normalizedSports], cutoff.getTime());

    const delAudit = await c.query(
      `DELETE FROM balance_audit_logs WHERE created_at < $1`,
      [cutoff]
    );
    const purgedAuditCount = delAudit.rowCount || 0;

    for (const rep of reports) {
      await c.query(
        `INSERT INTO game_12h_reports
         (period_start, period_end, game_name, total_bets, won_bets, lost_bets, total_wagered, total_payout, net_profit, actual_rtp, unique_players, audit_entries_purged)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          rep.period_start,
          rep.period_end,
          rep.game_name,
          rep.total_bets,
          rep.won_bets,
          rep.lost_bets,
          rep.total_wagered,
          rep.total_payout,
          rep.net_profit,
          rep.actual_rtp,
          rep.unique_players,
          purgedAuditCount
        ]
      );
    }

    const delBets = await c.query(
      `DELETE FROM universal_bets WHERE status IN ('WON', 'LOST', 'VOID') AND created_at < $1`,
      [cutoff]
    );
    const delSports = await c.query(
      `DELETE FROM sports_bets WHERE status IN ('WON','LOST','CASHED_OUT','VOID') AND created_at < $1`,
      [cutoff]
    ).catch(() => ({ rowCount: 0 }));
    const purgedBetsCount = (delBets.rowCount || 0) + (delSports.rowCount || 0);

    if (purgedBetsCount > 0 || purgedAuditCount > 0) {
      await c.query(
        `INSERT INTO admin_actions (actor, action, detail, ip) VALUES ($1, $2, $3, $4)`,
        [
          opts.actor || 'AUTO_12H_AUDIT',
          '12h-audit-prune',
          `Archived ${reports.length} game summaries; purged ${purgedBetsCount} bets & ${purgedAuditCount} audit logs (>12h)`,
          opts.ip || 'system'
        ]
      );
    }

    await c.query('COMMIT');
    return {
      success: true,
      cutoff: cutoff.toISOString(),
      reportsCreated: reports.length,
      purgedBets: purgedBetsCount,
      purgedAuditLogs: purgedAuditCount,
      reports
    };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

async function getRetentionStats(pool) {
  const [betsRes, auditRes, repRes] = await Promise.all([
    pool.query('SELECT COUNT(*) n FROM universal_bets'),
    pool.query('SELECT COUNT(*) n FROM balance_audit_logs'),
    pool.query('SELECT COUNT(*) n FROM game_12h_reports')
  ]);
  return {
    activeBetsInDb: Number(betsRes.rows[0]?.n || 0),
    activeAuditLogsInDb: Number(auditRes.rows[0]?.n || 0),
    archived12hReports: Number(repRes.rows[0]?.n || 0),
    retentionWindowHours: 12
  };
}

async function getReports12h(pool, limit = 100) {
  const r = await pool.query(
    `SELECT * FROM game_12h_reports ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows.map(x => ({
    id: x.id,
    periodStart: x.period_start,
    periodEnd: x.period_end,
    game: x.game_name,
    bets: Number(x.total_bets),
    won: Number(x.won_bets),
    lost: Number(x.lost_bets),
    wagered: num(x.total_wagered),
    payout: num(x.total_payout),
    profit: num(x.net_profit),
    rtp: num(x.actual_rtp),
    players: Number(x.unique_players),
    auditPurged: Number(x.audit_entries_purged || 0),
    createdAt: x.created_at
  }));
}

module.exports = {
  TWELVE_HOURS_MS,
  aggregateBetsFor12hReport,
  runTwelveHourAuditAndPrune,
  getRetentionStats,
  getReports12h
};
