/**
 * HULU BET - Production server (rewrite)
 * Required Render env vars: DATABASE_URL, BOT_TOKEN, ADMIN_PIN (8+ chars)
 * Optional: PORT, ALLOW_QUERY_PIN=1 (lets old admin pages send ?pin= until you update them)
 *
 * What changed vs the old server:
 *  - Every player call is authenticated with Telegram initData (userId is never trusted from the client)
 *  - Crash games (Aviator/JetX) are server-authoritative: crash point is secret until the round is settled,
 *    cashout multiplier is computed/validated on the server, winnings are always credited in the database
 *  - Real Keno (20 of 80 draw + generated paytable that matches TARGET_RTP)
 *  - Optional queries run inside SAVEPOINTs, so one failing side-query can no longer abort a whole payment
 *  - Schema self-heals on start (adds any missing columns/indexes used below)
 */
'use strict';
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();
const { createMockPool } = require('./mock-db');
const { r2, num, cashbackDue } = require('./lib/game-math');
const { runTwelveHourAuditAndPrune, getRetentionStats, getReports12h } = require('./lib/audit-rollup');
const { registerTelegramBot } = require('./lib/telegram-bot');
const { mountAllGames, CRASH_GAMES } = require('./games');
const { registerSportsbook } = require('./Sportserver');

const ENV = process.env;
const HAS_DB = Boolean(ENV.DATABASE_URL);
const HAS_BOT_TOKEN = Boolean(ENV.BOT_TOKEN);
const ADMIN_PIN = (ENV.ADMIN_PIN && ENV.ADMIN_PIN.length >= 8) ? ENV.ADMIN_PIN : '12345678';
if (!HAS_DB) console.warn('[AI Studio] DATABASE_URL not set — using in-memory mock database');
if (!HAS_BOT_TOKEN) console.warn('[AI Studio] BOT_TOKEN not set — demo browser session enabled');
if (!ENV.ADMIN_PIN || ENV.ADMIN_PIN.length < 8) console.warn('[AI Studio] ADMIN_PIN not set (or <8 chars) — using default demo PIN 12345678');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(cors());
app.use(express.json({ limit: '100kb' }));

const pool = HAS_DB
  ? new Pool({
      connectionString: ENV.DATABASE_URL.replace(/[?&]channel_binding=require/, ''),
      ssl: { rejectUnauthorized: false },
      max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000
    })
  : createMockPool();
if (HAS_DB) pool.on('error', e => console.error('pg idle client error:', e.message));

const CONFIG = {
  TARGET_RTP: 0.85, AGENT_COMMISSION: 0.02, WELCOME_BONUS: 20, REFERRAL_BONUS: 50,
  MIN_FIRST_DEP: 50, WAGER_REQ_MULT: 3, MIN_DEP: 50, MAX_DEP: 100000, MIN_WTH: 100, MAX_WTH: 50000,
  KENO_RTP: 0.70,   // Keno return-to-player (other games follow TARGET_RTP)
  MIN_BET: 1, MAX_BET: 1000, MAX_PAYOUT: 20000, SAFETY_BUFFER: 50000, MAX_CRASH: 100,
  DAILY_WTH_LIMIT: 100000, MAX_PENDING_WTH: 2, REVIEW_AMOUNT: 10000, DEP_EXPIRE_HOURS: 24
};
const AGENTS = ['Agent1hulubet', 'Agent2hulubet'];
const PAY_METHODS = ['Telebirr', 'CBE'];

// ---------------------------------------------------------------- helpers
class Biz extends Error { constructor(m, code = 400) { super(m); this.code = code; } }
const h = fn => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof Biz) return res.status(e.code).json({ success: false, message: e.message });
    if (e.code === '23505') return res.status(409).json({ success: false, message: 'Duplicate reference (already used)' });
    console.error('[ERR]', req.method, req.originalUrl, e.code || '', e.message); res.status(500).json({ success: false, message: 'Server error, please try again' });
  }
};
// Runs fn in a transaction. Postgres deadlock (40P01) / serialization (40001) errors are retried automatically,
// so fn must not have side effects outside the database (notifications, cache changes) - do those after tx() returns.
async function tx(fn, tries = 3) {
  for (let i = 1; ; i++) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      if ((e.code === '40P01' || e.code === '40001') && i < tries) { await new Promise(r => setTimeout(r, 30 * i + Math.random() * 60)); continue; }
      throw e;
    } finally { c.release(); }
  }
}
// Optional query inside a transaction: failure is rolled back to a savepoint instead of poisoning the transaction
async function opt(c, sql, p) {
  await c.query('SAVEPOINT sp');
  try { const r = await c.query(sql, p); await c.query('RELEASE SAVEPOINT sp'); return r; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); console.warn('optional query failed:', e.message); return null; }
}
const audit = (c, uid, act, amt, b, a, ref) => opt(c,
  `INSERT INTO balance_audit_logs (user_id,action_type,amount,balance_before,balance_after,reference_id) VALUES ($1,$2,$3,$4,$5,$6)`,
  [uid, act, amt, b, a, ref]);
const newId = p => `${p}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
const mask = s => (s ? String(s).slice(0, 2) : 'us') + '***';
const parseJson = v => (typeof v === 'string' ? JSON.parse(v) : (v || {}));

// Casino stats are summed in memory and written in ONE update every 3s. This removes the single hot 'casino_vault' row
// that every bet used to lock. Exact profit numbers in the admin dashboard come from universal_bets, not from this row.
// Call vaultAdd() only AFTER the bet's transaction has committed.
const vaultPending = { bal: 0, wagered: 0, payouts: 0, profit: 0, bonus: 0 };
const vaultAdd = d => { for (const k in d) vaultPending[k] += d[k] || 0; };
async function flushVault() {
  const p = { ...vaultPending };
  if (!Object.values(p).some(v => v)) return;
  for (const k in vaultPending) vaultPending[k] = 0;
  try {
    await pool.query(`UPDATE casino_vault SET vault_balance=vault_balance+$1,total_wagered=total_wagered+$2,total_payouts=total_payouts+$3,
      gross_profit=gross_profit+$4,total_bonus_awarded=total_bonus_awarded+$5,updated_at=NOW() WHERE id=1`, [p.bal, p.wagered, p.payouts, p.profit, p.bonus]);
  } catch (e) { for (const k in p) vaultPending[k] += p[k]; console.error('vault flush failed, will retry:', e.message); }
}
setInterval(flushVault, 3000).unref();
let vaultBalanceCache = 0;   // used only for the "is the bankroll healthy" check (SAFETY_BUFFER)
async function refreshVaultCache() { try { const r = await pool.query('SELECT vault_balance FROM casino_vault WHERE id=1'); vaultBalanceCache = num(r.rows[0]?.vault_balance); } catch (e) {} }
setInterval(refreshVaultCache, 10e3).unref();
const bankrollSafe = () => vaultBalanceCache + vaultPending.bal >= CONFIG.SAFETY_BUFFER;

// Active crash bets kept in memory: status polling (4/s per player) no longer touches the database.
// The database stays the source of truth; after a restart the cache refills itself on the first poll.
const flights = new Map();   // betId -> { uid, cp, auto, start(ms) }

const hits = new Map();
const limit = (name, max, ms) => (req, res, next) => {
  const k = name + ':' + (req.tg ? 'u' + req.tg.id : req.ip), now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= max) return res.status(429).json({ success: false, message: 'Too many requests, slow down' });
  a.push(now); hits.set(k, a); next();
};
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.length || n - a[a.length - 1] > 3600e3) hits.delete(k); }, 600e3).unref();

// ---- Telegram initData verification (fail closed on bad signatures and in production) ----
const ALLOW_DEMO = !HAS_BOT_TOKEN || ENV.ALLOW_DEMO_SESSION === '1' || ENV.NODE_ENV !== 'production';
function parseInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;
  if (ALLOW_DEMO && initData === 'demo_session') {
    return { id: '1000001', username: 'demo_player', first_name: 'Demo', last_name: 'Player' };
  }
  if (!HAS_BOT_TOKEN) return null;
  const p = new URLSearchParams(initData), hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(ENV.BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const age = Date.now() / 1000 - Number(p.get('auth_date') || 0);
  if (!(age > -300 && age < 86400)) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}
function userAuth(req, res, next) {
  const u = parseInitData(req.headers['x-telegram-init-data'] || req.body?.initData || req.query?.initData);
  if (!u || !u.id) {   // only FAILED logins count against an IP (many players can share one mobile-carrier IP)
    const k = 'authfail:' + req.ip, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < 60e3);
    a.push(now); hits.set(k, a);
    return res.status(a.length > 60 ? 429 : 401).json({ success: false, message: a.length > 60 ? 'Too many failed attempts' : 'Session expired. Please reopen the app from Telegram.' });
  }
  req.tg = { id: String(u.id), username: u.username || '', name: [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Player' };
  next();
}

// ---- Admin auth: constant-time compare + lockout after 5 wrong tries / 15 min ----
const adminFails = new Map();
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function adminAuth(req, res, next) {
  const f = adminFails.get(req.ip) || { n: 0, t: 0 }, fresh = Date.now() - f.t < 15 * 60e3;
  if (fresh && f.n >= 5) return res.status(429).json({ success: false, message: 'Locked. Try again in 15 minutes.' });
  const given = req.headers['x-admin-token'] || req.body?.pin || (ENV.ALLOW_QUERY_PIN === '1' ? req.query.pin : '') || '';
  if (!crypto.timingSafeEqual(sha(given), sha(ADMIN_PIN))) {
    adminFails.set(req.ip, { n: (fresh ? f.n : 0) + 1, t: Date.now() });
    return res.status(403).json({ success: false, message: 'Invalid Admin PIN!' });
  }
  adminFails.delete(req.ip); req.actor = String(req.body?.actor || 'Admin').slice(0, 40); next();
}
const admin = [limit('admin', 240, 60e3), adminAuth];
const alog = (req, action, detail) => pool.query(
  'INSERT INTO admin_actions (actor,action,detail,ip) VALUES ($1,$2,$3,$4)', [req.actor, action, String(detail).slice(0, 500), req.ip]).catch(() => {});

async function lockUser(c, uid) {
  const r = await c.query('SELECT * FROM users WHERE user_id=$1 FOR UPDATE', [uid]);
  if (!r.rows.length) throw new Biz('User not found', 404);
  if (['banned', 'suspended'].includes(String(r.rows[0].status).toLowerCase())) throw new Biz('Account is restricted. Contact support.', 403);
  return r.rows[0];
}
const validWager = v => {
  const w = r2(v);
  if (!Number.isFinite(w) || w < CONFIG.MIN_BET || w > CONFIG.MAX_BET) throw new Biz(`Bet must be between ${CONFIG.MIN_BET} and ${CONFIG.MAX_BET} ETB`);
  return w;
};
function validPicks(p) {
  if (!Array.isArray(p) || p.length < 1 || p.length > 10) throw new Biz('Pick 1 to 10 numbers');
  const n = p.map(Number), s = new Set(n);
  if (s.size !== n.length || n.some(x => !Number.isInteger(x) || x < 1 || x > 80)) throw new Biz('Invalid number picks');
  return n.sort((a, b) => a - b);
}
const userView = (u, isNew) => ({
  success: true, isNew, userId: u.user_id, username: u.telegram_username, name: u.full_name,
  balance: num(u.balance), bonusBalance: num(u.bonus_balance), totalDeposited: num(u.total_deposited),
  totalWagered: num(u.total_wagered), firstDepositCompleted: u.first_deposit_completed,
  wagerRequirementLeft: num(u.wager_requirement_left), role: u.role, status: u.status
});

// ---------------------------------------------------------------- schema + settings
async function ensureSchema() {
  const S = [
    `CREATE TABLE IF NOT EXISTS balance_audit_logs (id BIGSERIAL PRIMARY KEY,user_id VARCHAR(64),action_type VARCHAR(40),amount NUMERIC(14,2),balance_before NUMERIC(14,2),balance_after NUMERIC(14,2),reference_id VARCHAR(64),created_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(64) PRIMARY KEY,value TEXT)`,
    `CREATE TABLE IF NOT EXISTS admin_actions (id BIGSERIAL PRIMARY KEY,actor TEXT,action TEXT,detail TEXT,ip TEXT,created_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS game_12h_reports (id BIGSERIAL PRIMARY KEY,period_start TIMESTAMPTZ,period_end TIMESTAMPTZ,game_name VARCHAR(64),total_bets INTEGER,won_bets INTEGER,lost_bets INTEGER,total_wagered NUMERIC(14,2),total_payout NUMERIC(14,2),net_profit NUMERIC(14,2),actual_rtp NUMERIC(6,2),unique_players INTEGER,audit_entries_purged INTEGER DEFAULT 0,created_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS promo_codes (code VARCHAR(64) PRIMARY KEY,bonus_amount NUMERIC(14,2) NOT NULL,max_uses INTEGER DEFAULT 100,times_used INTEGER DEFAULT 0,is_active BOOLEAN DEFAULT TRUE,created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS bonus_amount NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS max_uses INTEGER DEFAULT 100, ADD COLUMN IF NOT EXISTS times_used INTEGER DEFAULT 0, ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`,
    `CREATE TABLE IF NOT EXISTS promo_redemptions (id BIGSERIAL PRIMARY KEY,user_id VARCHAR(64) NOT NULL,code VARCHAR(64) NOT NULL,amount_awarded NUMERIC(14,2) DEFAULT 0,created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE promo_redemptions ADD COLUMN IF NOT EXISTS amount_awarded NUMERIC(14,2) DEFAULT 0`,
    `INSERT INTO promo_codes (code,bonus_amount,max_uses) VALUES ('HULU50',50,100) ON CONFLICT (code) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS sports_bets (ticket_id VARCHAR(64) PRIMARY KEY,bet_id VARCHAR(64),user_id VARCHAR(64),username VARCHAR(128),match_id VARCHAR(64),match_title TEXT,market TEXT,odds NUMERIC(8,2),stake NUMERIC(14,2),potential_win NUMERIC(14,2),cashout_value NUMERIC(14,2),payout NUMERIC(14,2) DEFAULT 0,status VARCHAR(24) DEFAULT 'IN_PLAY',created_at TIMESTAMPTZ DEFAULT NOW(),settled_at TIMESTAMPTZ)`,
    `ALTER TABLE sports_bets ADD COLUMN IF NOT EXISTS ticket_id VARCHAR(64), ADD COLUMN IF NOT EXISTS bet_id VARCHAR(64), ADD COLUMN IF NOT EXISTS user_id VARCHAR(64), ADD COLUMN IF NOT EXISTS username VARCHAR(128), ADD COLUMN IF NOT EXISTS match_id VARCHAR(64), ADD COLUMN IF NOT EXISTS match_title TEXT, ADD COLUMN IF NOT EXISTS market TEXT, ADD COLUMN IF NOT EXISTS odds NUMERIC(8,2), ADD COLUMN IF NOT EXISTS stake NUMERIC(14,2), ADD COLUMN IF NOT EXISTS potential_win NUMERIC(14,2), ADD COLUMN IF NOT EXISTS cashout_value NUMERIC(14,2), ADD COLUMN IF NOT EXISTS payout NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS status VARCHAR(24) DEFAULT 'IN_PLAY', ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(), ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_sports_ticket ON sports_bets (ticket_id) WHERE ticket_id IS NOT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS wager_requirement_left NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS total_won NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS total_wagered NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS total_deposited NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS referrer_id VARCHAR(64) DEFAULT '', ADD COLUMN IF NOT EXISTS referral_paid BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS last_cashback_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS cashback_settled_loss NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ`,
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(), ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(), ADD COLUMN IF NOT EXISTS bank_txn_id VARCHAR(64), ADD COLUMN IF NOT EXISTS processed_by VARCHAR(64), ADD COLUMN IF NOT EXISTS agent_assigned VARCHAR(64), ADD COLUMN IF NOT EXISTS sender_account VARCHAR(128), ADD COLUMN IF NOT EXISTS remarks TEXT`,
    `ALTER TABLE universal_bets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(), ADD COLUMN IF NOT EXISTS flight_start TIMESTAMPTZ`,
    `ALTER TABLE casino_vault ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
    `INSERT INTO casino_vault (id) VALUES (1) ON CONFLICT DO NOTHING`,
    `UPDATE transactions SET bank_txn_id=NULL WHERE bank_txn_id=''`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_bank_ref ON transactions (bank_txn_id) WHERE bank_txn_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_user_code ON promo_redemptions (user_id, code)`,
    `CREATE INDEX IF NOT EXISTS idx_bets_user ON universal_bets (user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bets_created ON universal_bets (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_bets_status ON universal_bets (status)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_created ON balance_audit_logs (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_reports12h_created ON game_12h_reports (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sports_user ON sports_bets (user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions (type, status, created_at DESC)`
  ];
  for (const s of S) { try { await pool.query(s); } catch (e) { console.warn('schema step skipped:', e.message.slice(0, 120), '|', s.slice(0, 60)); } }
  if (HAS_DB) {
    try {
      const keep = new Set(['id', 'bet_id', 'ticket_id', 'user_id', 'username', 'match_id', 'match_title', 'market', 'odds', 'stake', 'potential_win', 'cashout_value', 'payout', 'status', 'created_at', 'settled_at']);
      const cols = await pool.query(`SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_name='sports_bets'`);
      for (const c of cols.rows) {
        if (!keep.has(c.column_name) && c.is_nullable === 'NO' && c.column_default === null && /^[a-z_][a-z0-9_]*$/.test(c.column_name)) {
          await pool.query(`ALTER TABLE sports_bets ALTER COLUMN "${c.column_name}" DROP NOT NULL`).catch(() => {});
        }
      }
    } catch (_) {}
  }
}
async function loadSettings() {
  try {
    const r = await pool.query('SELECT key,value FROM system_settings');
    const norm = v => { const x = parseFloat(v); return x > 1 ? x / 100 : x; };
    r.rows.forEach(({ key, value }) => {
      if (key === 'target_rtp') CONFIG.TARGET_RTP = norm(value);
      if (key === 'keno_rtp') CONFIG.KENO_RTP = norm(value);
      if (key === 'agent_commission') CONFIG.AGENT_COMMISSION = norm(value);
      if (key === 'welcome_bonus') CONFIG.WELCOME_BONUS = parseFloat(value);
      if (key === 'referral_bonus') CONFIG.REFERRAL_BONUS = parseFloat(value);
    });
  } catch (e) { console.warn('settings not loaded:', e.message); }
  if (ENV.KENO_RTP) CONFIG.KENO_RTP = (v => (v > 1 ? v / 100 : v))(parseFloat(ENV.KENO_RTP)) || CONFIG.KENO_RTP;
  console.log(`Settings: RTP=${CONFIG.TARGET_RTP * 100}% (Keno ${CONFIG.KENO_RTP * 100}%) commission=${CONFIG.AGENT_COMMISSION * 100}%`);
}

// Telegram notifications (player gets a message when a request is approved/rejected; admin chat gets new requests)
async function notify(chatId, text) {
  if (!HAS_BOT_TOKEN || typeof fetch !== 'function' || !/^\d+$/.test(String(chatId || ''))) return;
  try {
    await fetch(`https://api.telegram.org/bot${ENV.BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) });
  } catch (e) { console.warn('notify failed:', e.message); }
}
const notifyAdmins = text => ENV.ADMIN_CHAT_ID ? notify(ENV.ADMIN_CHAT_ID, text) : null;
const fmt = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- Unified payment gateway (Telebirr / CBE). The token lives ONLY in the VERIFI_TOKEN environment variable.
const AUTO_DEP_MAX = Number(ENV.AUTO_DEP_MAX || 2000);   // verified deposits above this wait for a cashier instead of auto-crediting
async function verifyWithGateway(ref, amount) {
  if (!ENV.VERIFI_TOKEN) throw new Biz('Automatic verification is not available right now. Use "Send Deposit Request".', 503);
  const u = new URL(ENV.VERIFI_URL || 'https://verifi-server.onrender.com/api/verify');
  u.searchParams.set('token', ENV.VERIFI_TOKEN); u.searchParams.set('ref', ref); u.searchParams.set('amount', String(amount));
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);   // the gateway may be waking up
  try {
    const r = await fetch(u, { signal: ctl.signal }), text = await r.text();
    let body = {}; try { body = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, body, raw: text.slice(0, 200) };
  } finally { clearTimeout(timer); }
}
// Fail closed: only an explicit "Verified" counts. (Tell me your gateway's real reply format and this can be made exact.)
const gatewayVerified = b => !!b && (String(b.status || '').toLowerCase() === 'verified' || b.verified === true);
const gatewayAmount = b => { const n = Number(b && (b.amount ?? (b.data && b.data.amount))); return Number.isFinite(n) && n > 0 ? n : null; };

// ---------------------------------------------------------------- static frontend + modular games + sportsbook + telegram bot
app.get('/', (_q, res) => res.sendFile(path.join(__dirname, 'homepage.html')));
app.get(['/admin', '/betadmin.html'], (_q, res) => res.sendFile(path.join(__dirname, 'betadmin.html')));
app.get('/homepage.html', (_q, res) => res.sendFile(path.join(__dirname, 'homepage.html')));
app.get('/game-bridge.js', (_q, res) => res.sendFile(path.join(__dirname, 'game-bridge.js')));

// ---------------------------------------------------------------- public
app.get('/api/ping', (_q, res) => res.json({ status: 'OK', timestamp: Date.now() }));
app.get('/api/heartbeat', (_q, res) => res.json({ status: 'ALIVE' }));
app.get('/api/agents', h(async (_q, res) => {
  const r = await pool.query('SELECT telegram_username FROM agents');
  res.json({ success: true, agents: r.rows });
}));
app.get('/api/user/history', userAuth, h(async (req, res) => {
  const r = await pool.query(
    `SELECT bet_id,game_name,bet_amount,multiplier,payout,status,created_at FROM universal_bets WHERE user_id=$1 AND status<>'IN_FLIGHT' ORDER BY created_at DESC LIMIT 30`,
    [req.tg.id]
  ).catch(() => ({ rows: [] }));
  res.json({
    success: true,
    history: r.rows.map(b => ({
      betId: b.bet_id,
      game: b.game_name,
      betAmount: num(b.bet_amount),
      multiplier: num(b.multiplier),
      payout: num(b.payout),
      status: b.status,
      createdAt: b.created_at
    }))
  });
}));
app.get('/api/public/feed', limit('feed', 60, 60e3), h(async (req, res) => {
  const game = CRASH_GAMES.includes(req.query.game) ? req.query.game : 'JetX';
  const [w, c] = await Promise.all([
    pool.query(`SELECT username,game_name,payout,multiplier FROM universal_bets WHERE status='WON' AND payout>=100 ORDER BY created_at DESC LIMIT 15`),
    pool.query(`SELECT game_data FROM universal_bets WHERE game_name=$1 AND status IN ('WON','LOST') ORDER BY created_at DESC LIMIT 30`, [game])
  ]);
  const seen = new Set(), crashes = [];
  for (const r of c.rows) { const g = parseJson(r.game_data); if (g.roundId && !seen.has(g.roundId)) { seen.add(g.roundId); crashes.push(g.crashPoint); } if (crashes.length >= 15) break; }
  res.json({ success: true, wins: w.rows.map(r => ({ user: mask(r.username), game: r.game_name, win: num(r.payout), mult: num(r.multiplier) })), crashes });
}));

// ---------------------------------------------------------------- 1. user init
const initHandler = h(async (req, res) => {
  const { id, username, name } = req.tg, refRaw = String(req.query.refId || req.body?.refId || '').trim().slice(0, 64);
  const out = await tx(async c => {
    let ref = '';
    if (refRaw && refRaw !== id) { const r = await c.query('SELECT 1 FROM users WHERE user_id=$1', [refRaw]); if (r.rows.length) ref = refRaw; }
    const wr = r2(CONFIG.WELCOME_BONUS * CONFIG.WAGER_REQ_MULT);
    const ins = await c.query(
      `INSERT INTO users (user_id,telegram_username,full_name,balance,bonus_balance,wager_requirement_left,referrer_id)
       VALUES ($1,$2,$3,$4,$4,$5,$6) ON CONFLICT (user_id) DO NOTHING RETURNING *`,
      [id, username || 'player', name, CONFIG.WELCOME_BONUS, wr, ref]);
    if (ins.rows.length) {
      await audit(c, id, 'WELCOME_BONUS', CONFIG.WELCOME_BONUS, 0, CONFIG.WELCOME_BONUS, 'WELCOME');
      return { u: ins.rows[0], isNew: true };
    }
    return { u: (await c.query('SELECT * FROM users WHERE user_id=$1', [id])).rows[0], isNew: false };
  });
  if (out.isNew) vaultAdd({ bonus: CONFIG.WELCOME_BONUS });
  res.json(userView(out.u, out.isNew));
});
app.get('/api/user/init', userAuth, limit('init', 60, 60e3), initHandler);
app.post('/api/user/init', userAuth, limit('init', 60, 60e3), initHandler);

// Shared context passed into every game module, Sportsbook & Telegram Bot
const appCtx = {
  pool, io, CONFIG, Biz, h, tx, audit, lockUser, validWager,
  newId, mask, parseJson, vaultAdd, userAuth, limit, flights, r2, num, parseInitData
};
const { shared: gameShared, chickenMod } = mountAllGames(app, appCtx, __dirname);
registerSportsbook(app, appCtx);
registerTelegramBot(app, { pool, env: ENV, config: CONFIG, notify });

// Safety net: settle rounds whose player disappeared + enforce 12-hour audit & retention cleanup
async function expireDeposits() {
  await pool.query(`UPDATE transactions SET status='FAILED',bank_txn_id=NULL,remarks='Verification timed out',updated_at=NOW() WHERE type='DEPOSIT' AND status='VERIFYING' AND created_at < NOW() - INTERVAL '5 minutes'`).catch(() => {});
  const r = await pool.query(`UPDATE transactions SET status='EXPIRED',remarks='Expired: not confirmed in time',updated_at=NOW() WHERE type='DEPOSIT' AND status='PENDING' AND created_at < NOW() - ($1 || ' hours')::interval`, [String(CONFIG.DEP_EXPIRE_HOURS)]);
  if (r.rowCount) console.log(`Expired ${r.rowCount} stale deposit requests`);
}
async function closeLegacyRounds() {
  const r = await pool.query(`UPDATE universal_bets SET status='LOST',house_profit=bet_amount WHERE status='IN_FLIGHT' AND flight_start IS NULL`);
  if (r.rowCount) console.log(`Closed ${r.rowCount} legacy stuck rounds`);
}
setInterval(async () => {
  try {
    await closeLegacyRounds();
    await expireDeposits();
    await chickenMod.settleStale();
    const r = await pool.query(`SELECT bet_id,user_id FROM universal_bets WHERE status='IN_FLIGHT' AND game_name=ANY($1) AND flight_start < NOW() - INTERVAL '5 minutes' LIMIT 100`, [CRASH_GAMES]);
    for (const b of r.rows) {
      try { const vd = await tx(async c => { const v = []; await gameShared.resolveCrash(c, b.bet_id, b.user_id, { vd: v }); return v; }); vd.forEach(vaultAdd); }
      catch (e) { console.error('sweep', e.message); }
    }
    for (const [k, f] of flights) if (Date.now() - f.start > 600e3) flights.delete(k);
  } catch (e) { console.error('sweeper:', e.message); }
}, 60e3).unref();

// Periodic 12-hour audit & purge every 30 minutes (guarantees no raw game/audit rows stay past 12h)
setInterval(() => {
  runTwelveHourAuditAndPrune(pool).then(res => {
    if (res.purgedBets || res.purgedAuditLogs) {
      console.log(`12h Audit Rollup: ${res.reportsCreated} game summaries, purged ${res.purgedBets} bets & ${res.purgedAuditLogs} audit logs`);
    }
  }).catch(e => console.error('12h audit error:', e.message));
}, 30 * 60e3).unref();

// ---------------------------------------------------------------- 3. cashier
app.post('/api/cashier/deposit', userAuth, limit('dep', 20, 60e3), h(async (req, res) => {
  const amt = r2(req.body.amount), method = PAY_METHODS.includes(req.body.method) ? req.body.method : 'Telebirr';
  const agent = AGENTS.includes(req.body.agentAssigned) ? req.body.agentAssigned : AGENTS[0];
  const ref = String(req.body.bankRef || '').trim().toUpperCase() || null;
  if (!(amt >= CONFIG.MIN_DEP && amt <= CONFIG.MAX_DEP)) throw new Biz(`Deposit must be between ${CONFIG.MIN_DEP} and ${CONFIG.MAX_DEP} ETB`);
  if (ref && !/^[A-Za-z0-9]{6,30}$/.test(ref)) throw new Biz('Payment reference must be 6-30 letters/numbers');
  const u = await pool.query('SELECT status FROM users WHERE user_id=$1', [req.tg.id]);
  if (!u.rows.length) throw new Biz('User not found', 404);
  if (['banned', 'suspended'].includes(String(u.rows[0].status).toLowerCase())) throw new Biz('Account is restricted. Contact support.', 403);
  const p = await pool.query(`SELECT COUNT(*) n FROM transactions WHERE user_id=$1 AND type='DEPOSIT' AND status='PENDING'`, [req.tg.id]);
  if (Number(p.rows[0].n) >= 5) throw new Biz('You have too many pending deposits. Wait for the cashier or cancel one.');
  const id = newId('DEP');
  await pool.query(`INSERT INTO transactions (txn_id,user_id,username,type,method,amount,net_amount,agent_assigned,bank_txn_id,status,remarks)
    VALUES ($1,$2,$3,'DEPOSIT',$4,$5,$5,$6,$7,'PENDING','Pending cashier verification')`, [id, req.tg.id, req.tg.username || 'player', method, amt, agent, ref]); // reused reference -> 409
  notifyAdmins(`NEW DEPOSIT ${id}\n${fmt(amt)} ETB via ${method}\nPlayer: @${req.tg.username || '-'} (${req.tg.id})${ref ? '\nRef: ' + ref : ''}`);
  res.json({ success: true, txnId: id, agent });
}));

app.post('/api/cashier/verify-deposit', userAuth, limit('verify', 12, 600e3), h(async (req, res) => {
  const method = PAY_METHODS.includes(req.body.method) ? req.body.method : 'Telebirr';
  const raw = String(req.body.ref || '').trim(), ref = raw.toUpperCase(), amt = r2(req.body.amount), uid = req.tg.id;
  if (!/^[A-Za-z0-9-]{6,40}$/.test(raw)) throw new Biz('Enter the transaction reference exactly as it appears in your payment message');
  if (!(amt >= CONFIG.MIN_DEP && amt <= CONFIG.MAX_DEP)) throw new Biz(`Deposit must be between ${CONFIG.MIN_DEP} and ${CONFIG.MAX_DEP} ETB`);
  if (!ENV.VERIFI_TOKEN) throw new Biz('Automatic verification is not available right now. Use "Send Deposit Request".', 503);
  const u = await pool.query('SELECT status FROM users WHERE user_id=$1', [uid]);
  if (!u.rows.length) throw new Biz('User not found', 404);
  if (['banned', 'suspended'].includes(String(u.rows[0].status).toLowerCase())) throw new Biz('Account is restricted. Contact support.', 403);
  const fails = await pool.query(`SELECT COUNT(*) n FROM transactions WHERE user_id=$1 AND type='DEPOSIT' AND status='FAILED' AND created_at > NOW() - INTERVAL '1 hour'`, [uid]);
  if (Number(fails.rows[0].n) >= 8) throw new Biz('Too many failed verifications. Try again in an hour or contact support.', 429);

  // Reserve the reference BEFORE asking the gateway: the unique index guarantees one claim per payment, even with parallel requests.
  let id = newId('DEP');
  try {
    await pool.query(`INSERT INTO transactions (txn_id,user_id,username,type,method,amount,net_amount,bank_txn_id,status,remarks,processed_by)
      VALUES ($1,$2,$3,'DEPOSIT',$4,$5,$5,$6,'VERIFYING','Checking payment','AUTO')`, [id, uid, req.tg.username || 'player', method, amt, ref]);
  } catch (e) {
    if (e.code !== '23505') throw e;
    const ex = (await pool.query(`SELECT txn_id,user_id,status FROM transactions WHERE bank_txn_id=$1`, [ref])).rows[0];   // his own pending request with this reference: use it
    if (!ex || ex.user_id !== uid || ex.status !== 'PENDING') throw new Biz('This payment reference was already used.', 409);
    const up = await pool.query(`UPDATE transactions SET status='VERIFYING',amount=$1,net_amount=$1,method=$2,remarks='Checking payment',processed_by='AUTO' WHERE txn_id=$3 AND status='PENDING'`, [amt, method, ex.txn_id]);
    if (!up.rowCount) throw new Biz('This payment reference was already used.', 409);
    id = ex.txn_id;
  }
  const release = (why) => pool.query(`UPDATE transactions SET status='FAILED',bank_txn_id=NULL,remarks=$1,updated_at=NOW() WHERE txn_id=$2 AND status='VERIFYING'`, [why, id]).catch(() => {});

  let g;
  try { g = await verifyWithGateway(raw, amt); }
  catch (e) { await release('Gateway unreachable'); if (e instanceof Biz) throw e; throw new Biz('Could not reach the payment checker. Please try again in a minute.', 503); }
  if (!gatewayVerified(g.body)) { await release('Payment not found'); throw new Biz('Payment not found yet. Check the reference and amount, wait a minute and try again.', 404); }
  const gAmt = gatewayAmount(g.body);
  if (gAmt !== null && Math.abs(gAmt - amt) > 0.01) { await release(`Amount differs (${gAmt})`); throw new Biz(`The payment amount (${gAmt} ETB) does not match the amount you entered.`, 400); }

  if (amt > AUTO_DEP_MAX) {
    await pool.query(`UPDATE transactions SET status='PENDING',remarks='Verified by gateway, waiting for cashier (large amount)',updated_at=NOW() WHERE txn_id=$1 AND status='VERIFYING'`, [id]);
    notifyAdmins(`VERIFIED DEPOSIT NEEDS APPROVAL ${id}\n${fmt(amt)} ETB via ${method}, ref ${ref}\nPlayer: @${req.tg.username || '-'} (${uid})`);
    return res.json({ success: true, pending: true, txnId: id, message: 'Payment verified. Large deposits are approved by the cashier shortly.' });
  }
  const out = await tx(async c => {
    const t = (await c.query(`SELECT * FROM transactions WHERE txn_id=$1 AND status='VERIFYING' FOR UPDATE`, [id])).rows[0];
    if (!t) throw new Biz('This deposit was already processed');
    const usr = (await c.query('SELECT * FROM users WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
    const before = num(usr.balance), after = r2(before + amt), first = usr.first_deposit_completed !== 'YES';
    await c.query(`UPDATE users SET balance=$1,total_deposited=total_deposited+$2,first_deposit_completed='YES' WHERE user_id=$3`, [after, amt, uid]);
    await c.query(`UPDATE transactions SET status='APPROVED',remarks='Auto-verified by gateway',processed_by='AUTO',updated_at=NOW() WHERE txn_id=$1`, [id]);
    await audit(c, uid, 'DEPOSIT_AUTO', amt, before, after, id);
    if (first && amt >= CONFIG.MIN_FIRST_DEP) await creditReferral(c, uid);
    return { after };
  });
  res.json({ success: true, txnId: id, credited: amt, newBalance: out.after, message: `Deposit of ${fmt(amt)} ETB verified and added to your balance.` });
}));

// Player cancels his own PENDING request (a cancelled withdrawal is refunded)
app.post('/api/cashier/cancel', userAuth, limit('cancel', 20, 60e3), h(async (req, res) => {
  const id = String(req.body.txnId || '');
  const out = await tx(async c => {
    const t = (await c.query(`SELECT * FROM transactions WHERE txn_id=$1 AND user_id=$2 AND type IN ('DEPOSIT','WITHDRAWAL') AND status='PENDING' FOR UPDATE`, [id, req.tg.id])).rows[0];
    if (!t) throw new Biz('Request not found or already processed');
    let newBal = null;
    if (t.type === 'WITHDRAWAL') {
      const u = await lockUser(c, req.tg.id), before = num(u.balance), amt = num(t.amount);
      newBal = r2(before + amt);
      await c.query('UPDATE users SET balance=$1 WHERE user_id=$2', [newBal, req.tg.id]);
      await audit(c, req.tg.id, 'WITHDRAWAL_CANCEL', amt, before, newBal, id);
    }
    await c.query(`UPDATE transactions SET status='CANCELLED',remarks='Cancelled by player',updated_at=NOW() WHERE txn_id=$1`, [id]);
    return { type: t.type, newBal };
  });
  res.json({ success: true, type: out.type, newBalance: out.newBal, message: out.type === 'WITHDRAWAL' ? 'Withdrawal cancelled and refunded' : 'Deposit request cancelled' });
}));

app.get('/api/cashier/history', userAuth, limit('hist', 60, 60e3), h(async (req, res) => {
  const r = await pool.query(`SELECT txn_id,type,method,amount,status,remarks,created_at FROM transactions
    WHERE user_id=$1 AND type IN ('DEPOSIT','WITHDRAWAL') ORDER BY created_at DESC LIMIT 30`, [req.tg.id]);
  res.json({ success: true, items: r.rows.map(t => ({ id: t.txn_id, type: t.type, method: t.method, amount: num(t.amount),
    status: String(t.status).toLowerCase(), note: String(t.status).toUpperCase() === 'REJECTED' ? (t.remarks || '') : '', at: t.created_at })) });
}));

app.post('/api/cashier/withdraw', userAuth, limit('wd', 10, 60e3), h(async (req, res) => {
  const amt = r2(req.body.amount), acc = String(req.body.accountNumber || '').trim(), method = PAY_METHODS.includes(req.body.method) ? req.body.method : 'Telebirr';
  if (!(amt >= CONFIG.MIN_WTH && amt <= CONFIG.MAX_WTH)) throw new Biz(`Withdrawal must be between ${CONFIG.MIN_WTH} and ${CONFIG.MAX_WTH} ETB`);
  if (!/^[0-9+\-\s]{8,20}$/.test(acc)) throw new Biz('Enter a valid phone / account number');
  const out = await tx(async c => {
    const u = await lockUser(c, req.tg.id), bal = num(u.balance);
    if (bal < amt) throw new Biz('Insufficient balance');
    if (u.first_deposit_completed !== 'YES' && num(u.total_deposited) < CONFIG.MIN_FIRST_DEP) throw new Biz(`Deposit at least ${CONFIG.MIN_FIRST_DEP} ETB first to unlock withdrawals`);
    if (num(u.wager_requirement_left) > 0) throw new Biz(`Bonus wagering active: ${num(u.wager_requirement_left).toFixed(2)} ETB left to wager`);
    if (num(u.total_wagered) < num(u.total_deposited)) throw new Biz(`Turnover rule: wager ${r2(num(u.total_deposited) - num(u.total_wagered)).toFixed(2)} ETB more before withdrawing`);
    const inflight = await c.query(`SELECT 1 FROM universal_bets WHERE user_id=$1 AND status='IN_FLIGHT' AND flight_start > NOW() - INTERVAL '6 minutes' LIMIT 1`, [req.tg.id]);
    if (inflight.rows.length) throw new Biz('Finish your running game round first');
    const pend = await c.query(`SELECT COUNT(*) n FROM transactions WHERE user_id=$1 AND type='WITHDRAWAL' AND status='PENDING'`, [req.tg.id]);
    if (Number(pend.rows[0].n) >= CONFIG.MAX_PENDING_WTH) throw new Biz('You already have a pending withdrawal. Wait for it or cancel it.');
    const day = await c.query(`SELECT COALESCE(SUM(amount),0) s,COUNT(*) n FROM transactions WHERE user_id=$1 AND type='WITHDRAWAL' AND status IN ('PENDING','APPROVED') AND created_at>=NOW()-INTERVAL '24 hours'`, [req.tg.id]);
    if (num(day.rows[0].s) + amt > CONFIG.DAILY_WTH_LIMIT) throw new Biz(`Daily withdrawal limit is ${CONFIG.DAILY_WTH_LIMIT} ETB`);
    const prior = await c.query(`SELECT COUNT(*) n FROM transactions WHERE user_id=$1 AND type='WITHDRAWAL' AND status='APPROVED'`, [req.tg.id]);
    const flags = [Number(prior.rows[0].n) === 0 ? 'FIRST WITHDRAWAL' : '', amt >= CONFIG.REVIEW_AMOUNT ? 'LARGE AMOUNT' : ''].filter(Boolean);
    const note = 'Awaiting admin payout' + (flags.length ? ' | REVIEW: ' + flags.join(', ') : '');
    const newBal = r2(bal - amt), id = newId('WTH');
    await c.query('UPDATE users SET balance=$1 WHERE user_id=$2', [newBal, req.tg.id]);
    await c.query(`INSERT INTO transactions (txn_id,user_id,username,type,method,amount,net_amount,sender_account,status,remarks)
      VALUES ($1,$2,$3,'WITHDRAWAL',$4,$5,$5,$6,'PENDING',$7)`, [id, req.tg.id, u.telegram_username, method, amt, acc, note]);
    await audit(c, req.tg.id, 'WITHDRAWAL_HOLD', amt, bal, newBal, id);
    return { id, newBal, note, uname: u.telegram_username };
  });
  notifyAdmins(`NEW WITHDRAWAL ${out.id}\n${fmt(amt)} ETB via ${method} to ${acc}\nPlayer: @${out.uname || '-'} (${req.tg.id})${out.note.includes('REVIEW') ? '\n' + out.note.split('| ')[1] : ''}`);
  res.json({ success: true, txnId: out.id, newBalance: out.newBal });
}));

app.post('/api/promo/redeem', userAuth, limit('promo', 10, 60e3), h(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 40);
  if (!code) throw new Biz('Enter a promo code');
  const out = await tx(async c => {
    const u = await lockUser(c, req.tg.id);
    const p = (await c.query(`SELECT * FROM promo_codes WHERE code=$1 AND LOWER(COALESCE(is_active::text,'false')) IN ('true','t','1','yes') FOR UPDATE`, [code])).rows[0];
    if (!p) throw new Biz('Invalid or expired promo code', 404);
    if (p.times_used >= p.max_uses) throw new Biz('Promo code limit reached');
    if ((await c.query('SELECT 1 FROM promo_redemptions WHERE user_id=$1 AND code=$2', [req.tg.id, code])).rows.length) throw new Biz('You already claimed this promo code');
    const bonus = num(p.bonus_amount), wr = r2(bonus * CONFIG.WAGER_REQ_MULT), before = num(u.balance), after = r2(before + bonus);
    await c.query('UPDATE users SET balance=$1,bonus_balance=bonus_balance+$2,wager_requirement_left=wager_requirement_left+$3 WHERE user_id=$4', [after, bonus, wr, req.tg.id]);
    await c.query('INSERT INTO promo_redemptions (user_id,code,amount_awarded) VALUES ($1,$2,$3)', [req.tg.id, code, bonus]);
    await c.query('UPDATE promo_codes SET times_used=times_used+1 WHERE code=$1', [code]);
    await audit(c, req.tg.id, 'PROMO_CLAIM', bonus, before, after, code);
    return { bonus, wr, after };
  });
  res.json({ success: true, awarded: out.bonus, message: `+${out.bonus.toFixed(2)} ETB added (wager ${out.wr} ETB to withdraw)`, newBalance: out.after });
}));

// ---------------------------------------------------------------- 4. admin
async function creditReferral(c, uid) {
  const u = (await c.query('SELECT referrer_id,referral_paid FROM users WHERE user_id=$1', [uid])).rows[0];
  if (!u || u.referral_paid || !u.referrer_id) return;
  await c.query('UPDATE users SET referral_paid=TRUE WHERE user_id=$1', [uid]);
  const r = (await c.query('SELECT balance FROM users WHERE user_id=$1 FOR UPDATE', [u.referrer_id])).rows[0];
  if (!r) return;
  const b = num(r.balance), a = r2(b + CONFIG.REFERRAL_BONUS), wr = r2(CONFIG.REFERRAL_BONUS * CONFIG.WAGER_REQ_MULT);
  await c.query('UPDATE users SET balance=$1,bonus_balance=bonus_balance+$2,wager_requirement_left=wager_requirement_left+$3 WHERE user_id=$4', [a, CONFIG.REFERRAL_BONUS, wr, u.referrer_id]);
  await c.query('UPDATE casino_vault SET total_bonus_awarded=total_bonus_awarded+$1 WHERE id=1', [CONFIG.REFERRAL_BONUS]);
  await audit(c, u.referrer_id, 'REFERRAL_BONUS', CONFIG.REFERRAL_BONUS, b, a, uid);
}
const payAgent = (c, agent, amt) => opt(c,
  `UPDATE agents SET total_deposits_processed=total_deposits_processed+$1,total_commission_earned=total_commission_earned+$2 WHERE telegram_username ILIKE $3 OR agent_id=$3`,
  [amt, r2(amt * CONFIG.AGENT_COMMISSION), agent]);
const fmtTx = t => ({ id: t.txn_id, u: t.username || t.user_id, uid: t.user_id, m: t.method || 'Telebirr', amt: num(t.amount), st: String(t.status).toLowerCase(), acc: t.sender_account, at: t.created_at });

const dashboard = h(async (_req, res) => {
  const q = (s, p) => pool.query(s, p);
  const [vault, cnt, pd, pw, rec, deps, wds, bets, promos, users, ggr, gs, retentionStats, reports12h] = await Promise.all([
    q('SELECT * FROM casino_vault WHERE id=1'),
    q('SELECT COUNT(*) n FROM users'),
    q(`SELECT * FROM transactions WHERE type='DEPOSIT' AND status='PENDING' ORDER BY created_at DESC LIMIT 200`),
    q(`SELECT * FROM transactions WHERE type='WITHDRAWAL' AND status='PENDING' ORDER BY created_at DESC LIMIT 200`),
    q(`SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50`),
    q(`SELECT * FROM transactions WHERE type='DEPOSIT' ORDER BY created_at DESC LIMIT 100`),
    q(`SELECT * FROM transactions WHERE type='WITHDRAWAL' ORDER BY created_at DESC LIMIT 100`),
    q(`SELECT * FROM universal_bets WHERE status<>'IN_FLIGHT' ORDER BY created_at DESC LIMIT 50`),
    q('SELECT * FROM promo_codes ORDER BY code'),
    q(`SELECT u.*,(SELECT COUNT(*) FROM universal_bets b WHERE b.user_id=u.user_id) AS bet_count FROM users u ORDER BY u.balance DESC LIMIT 100`),
    q(`SELECT COALESCE(SUM(house_profit) FILTER (WHERE created_at>=date_trunc('day',NOW())),0) d,
              COALESCE(SUM(house_profit) FILTER (WHERE created_at>=date_trunc('month',NOW())),0) m FROM universal_bets WHERE status IN ('WON','LOST')`),
    q(`SELECT game_name,COUNT(*) bets,COALESCE(SUM(bet_amount),0) wagered,COALESCE(SUM(payout),0) paid FROM universal_bets WHERE status IN ('WON','LOST') GROUP BY game_name`),
    getRetentionStats(pool).catch(() => ({ activeBetsInDb: 0, activeAuditLogsInDb: 0, archived12hReports: 0, retentionWindowHours: 12 })),
    getReports12h(pool, 100).catch(() => [])
  ]);
  const v = vault.rows[0] || {};
  const bonusM = await q(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='BONUS' AND created_at>=date_trunc('month',NOW())`).catch(() => ({ rows: [{ s: 0 }] }));
  const usersList = users.rows.map(userRow);
  res.json({
    success: true,
    vault: { gross_profit: num(v.gross_profit), vault_balance: num(v.vault_balance), total_wagered: num(v.total_wagered), ggrToday: num(ggr.rows[0].d), ngrMonth: r2(num(ggr.rows[0].m) - num(bonusM.rows[0].s)), vaultBalance: num(v.vault_balance), totalWagered: num(v.total_wagered) },
    totalUsers: Number(cnt.rows[0].n), currentRtp: CONFIG.TARGET_RTP, currentCommission: CONFIG.AGENT_COMMISSION,
    pendingDeposits: pd.rows, pendingWithdrawals: pw.rows, completedHistory: rec.rows.filter(t => t.status !== 'PENDING'), recentTransactions: rec.rows,
    usersList, users: usersList, dep: deps.rows.map(fmtTx), wd: wds.rows.map(fmtTx),
    bets: bets.rows.map(b => ({ id: b.bet_id, u: b.username || b.user_id, m: b.game_name, p: num(b.multiplier) + 'x', s: num(b.bet_amount), st: String(b.status).toLowerCase() })),
    promos: promos.rows.map(p => ({ c: p.code, code: p.code, d: `+${p.bonus_amount} ETB (${p.times_used}/${p.max_uses})`, on: p.is_active ? 1 : 0 })),
    gameStats: gs.rows.map(g => ({ game: g.game_name, bets: Number(g.bets), wagered: num(g.wagered), paid: num(g.paid), rtp: num(g.wagered) ? r2(num(g.paid) / num(g.wagered) * 100) : 0 })),
    retentionStats,
    reports12h,
    settings: { targetRtp: r2(CONFIG.TARGET_RTP * 100), kenoRtp: r2(CONFIG.KENO_RTP * 100), agentCommission: r2(CONFIG.AGENT_COMMISSION * 100), minDep: CONFIG.MIN_DEP, maxDep: CONFIG.MAX_DEP, minWd: CONFIG.MIN_WTH, maxWd: CONFIG.MAX_WTH }
  });
});
const userRow = u => ({
  id: u.user_id, user_id: u.user_id, name: u.full_name || u.telegram_username, telegram_username: u.telegram_username,
  bal: num(u.balance), balance: num(u.balance), st: String(u.status || 'active').toLowerCase(), status: String(u.status || 'active').toLowerCase(),
  total_deposited: num(u.total_deposited), total_wagered: num(u.total_wagered), total_won: num(u.total_won),
  kyc: num(u.total_deposited) >= CONFIG.MIN_FIRST_DEP ? 'verified' : 'pending', bets: Number(u.bet_count || 0), lim: 5000
});
app.get('/api/admin/master-dashboard', admin, dashboard);
app.get('/api/admin/analytics', admin, dashboard);

app.get('/api/admin/reports-12h', admin, h(async (req, res) => {
  const [retentionStats, reports] = await Promise.all([
    getRetentionStats(pool),
    getReports12h(pool, Math.min(200, parseInt(req.query.limit || '100', 10) || 100))
  ]);
  res.json({ success: true, retentionStats, reports });
}));

app.post('/api/admin/run-12h-audit', admin, h(async (req, res) => {
  const out = await runTwelveHourAuditAndPrune(pool, { actor: req.actor, ip: req.ip });
  res.json({
    ...out,
    message: `12h Audit complete: ${out.reportsCreated} summaries created, ${out.purgedBets} bets & ${out.purgedAuditLogs} audit logs pruned`
  });
}));

app.get('/api/admin/users', admin, h(async (req, res) => {
  const s = String(req.query.q || '').trim(), page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
  const r = await pool.query(`SELECT u.*,(SELECT COUNT(*) FROM universal_bets b WHERE b.user_id=u.user_id) AS bet_count FROM users u
    WHERE ($1::text='' OR u.user_id ILIKE $2 OR u.telegram_username ILIKE $2 OR u.full_name ILIKE $2) ORDER BY u.balance DESC LIMIT 100 OFFSET $3`, [s, `%${s}%`, page * 100]);
  res.json({ success: true, users: r.rows.map(userRow), page });
}));
app.get('/api/admin/audit', admin, h(async (_q, res) => {
  const r = await pool.query('SELECT * FROM admin_actions ORDER BY id DESC LIMIT 200');
  res.json({ success: true, log: r.rows });
}));

app.post('/api/admin/approve-deposit', admin, h(async (req, res) => {
  const txnId = String(req.body.txnId || ''); if (!txnId) throw new Biz('Transaction ID required');
  const bankRef = String(req.body.bankRef || '').trim().slice(0, 40).toUpperCase() || null;   // bank/Telebirr reference: a reused one is rejected (409)
  const out = await tx(async c => {
    const t = (await c.query(`SELECT * FROM transactions WHERE txn_id=$1 AND type='DEPOSIT' AND status='PENDING' FOR UPDATE`, [txnId])).rows[0];
    if (!t) throw new Biz('Deposit already processed or not found');
    const amt = num(t.amount), u = (await c.query('SELECT * FROM users WHERE user_id=$1 FOR UPDATE', [t.user_id])).rows[0];
    if (!u) throw new Biz('User not found', 404);
    const before = num(u.balance), after = r2(before + amt), first = u.first_deposit_completed !== 'YES';
    await c.query(`UPDATE users SET balance=$1,total_deposited=total_deposited+$2,first_deposit_completed='YES' WHERE user_id=$3`, [after, amt, t.user_id]);
    await payAgent(c, t.agent_assigned || req.actor, amt);
    await c.query(`UPDATE transactions SET status='APPROVED',remarks=$1,processed_by=$2,bank_txn_id=COALESCE($4,bank_txn_id),updated_at=NOW() WHERE txn_id=$3`, [`Approved by ${req.actor}`, req.actor, txnId, bankRef]);
    await audit(c, t.user_id, 'DEPOSIT_APPROVE', amt, before, after, txnId);
    if (first && amt >= CONFIG.MIN_FIRST_DEP) await creditReferral(c, t.user_id);
    return { amt, uid: t.user_id };
  });
  alog(req, 'approve-deposit', `${txnId} ${out.amt} -> ${out.uid}`);
  notify(out.uid, `Your deposit of ${fmt(out.amt)} ETB was approved.`);
  res.json({ success: true, message: `Deposit ${txnId} approved (+${out.amt} ETB to ${out.uid})` });
}));
app.post('/api/admin/reject-deposit', admin, h(async (req, res) => {
  const reason = String(req.body.reason || 'Payment verification failed').slice(0, 200);
  const r = await pool.query(`UPDATE transactions SET status='REJECTED',remarks=$1,processed_by=$2,updated_at=NOW() WHERE txn_id=$3 AND type='DEPOSIT' AND status='PENDING' RETURNING user_id,amount`,
    [reason, req.actor, String(req.body.txnId || '')]);
  if (!r.rowCount) throw new Biz('Deposit already processed or not found');
  alog(req, 'reject-deposit', req.body.txnId);
  notify(r.rows[0].user_id, `Your deposit of ${fmt(r.rows[0].amount)} ETB was rejected.\nReason: ${reason}`);
  res.json({ success: true, message: `Deposit ${req.body.txnId} rejected` });
}));
app.post('/api/admin/approve-withdrawal', admin, h(async (req, res) => {
  const r = await pool.query(`UPDATE transactions SET status='APPROVED',remarks=$1,processed_by=$2,updated_at=NOW() WHERE txn_id=$3 AND type='WITHDRAWAL' AND status='PENDING' RETURNING user_id,amount,method`,
    [`Payout completed by ${req.actor}`, req.actor, String(req.body.txnId || '')]);
  if (!r.rowCount) throw new Biz('Withdrawal already processed or not found');
  alog(req, 'approve-withdrawal', req.body.txnId);
  notify(r.rows[0].user_id, `Your withdrawal of ${fmt(r.rows[0].amount)} ETB was paid out via ${r.rows[0].method}.`);
  res.json({ success: true, message: `Withdrawal ${req.body.txnId} marked completed` });
}));
app.post('/api/admin/reject-withdrawal', admin, h(async (req, res) => {
  const txnId = String(req.body.txnId || '');
  const out = await tx(async c => {
    const t = (await c.query(`SELECT * FROM transactions WHERE txn_id=$1 AND type='WITHDRAWAL' AND status='PENDING' FOR UPDATE`, [txnId])).rows[0];
    if (!t) throw new Biz('Withdrawal not found or already processed');
    const amt = num(t.amount), u = (await c.query('SELECT balance FROM users WHERE user_id=$1 FOR UPDATE', [t.user_id])).rows[0];
    const before = num(u.balance), after = r2(before + amt);
    await c.query('UPDATE users SET balance=$1 WHERE user_id=$2', [after, t.user_id]);
    await c.query(`UPDATE transactions SET status='REJECTED',remarks=$1,processed_by=$2,updated_at=NOW() WHERE txn_id=$3`, [String(req.body.reason || 'Rejected by admin (refunded)').slice(0, 200), req.actor, txnId]);
    await audit(c, t.user_id, 'WITHDRAWAL_REFUND', amt, before, after, txnId);
    return { amt, uid: t.user_id };
  });
  alog(req, 'reject-withdrawal', `${txnId} refund ${out.amt}`);
  notify(out.uid, `Your withdrawal of ${fmt(out.amt)} ETB was rejected and the money was returned to your balance.`);
  res.json({ success: true, message: `Withdrawal ${txnId} rejected, ${out.amt} ETB refunded to ${out.uid}` });
}));

app.post('/api/admin/topup', admin, h(async (req, res) => {
  const uid = String(req.body.userId || '').trim(), amt = r2(req.body.amount), ref = String(req.body.txnId || '').trim().toUpperCase() || null;
  if (!uid || !(amt >= CONFIG.MIN_DEP && amt <= CONFIG.MAX_DEP)) throw new Biz('Valid user ID and amount required');
  await tx(async c => {
    const u = (await c.query('SELECT * FROM users WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
    if (!u) throw new Biz('User not found. Check the ID.', 404);
    const before = num(u.balance), after = r2(before + amt), first = u.first_deposit_completed !== 'YES', id = newId('DEP');
    await c.query(`INSERT INTO transactions (txn_id,user_id,username,type,method,amount,net_amount,bank_txn_id,status,processed_by,remarks)
      VALUES ($1,$2,$3,'DEPOSIT','Manual_1Click',$4,$4,$5,'APPROVED',$6,'Manual top-up')`, [id, uid, u.telegram_username, amt, ref, req.actor]); // unique index rejects a reused bank reference
    await c.query(`UPDATE users SET balance=$1,total_deposited=total_deposited+$2,first_deposit_completed='YES' WHERE user_id=$3`, [after, amt, uid]);
    await payAgent(c, req.actor, amt);
    await audit(c, uid, 'TOPUP', amt, before, after, id);
    if (first && amt >= CONFIG.MIN_FIRST_DEP) await creditReferral(c, uid);
  });
  alog(req, 'topup', `${uid} ${amt} ref=${ref}`);
  res.json({ success: true, message: `Credited ${amt} ETB to player ${uid}` });
}));
app.post('/api/admin/adjust-balance', admin, h(async (req, res) => {
  const uid = String(req.body.userId || '').trim(), amt = r2(req.body.amount), action = req.body.action;
  if (!uid || !(amt > 0) || amt > 1000000) throw new Biz('Valid user ID and positive amount required');
  if (!['ADD', 'DEDUCT'].includes(action)) throw new Biz("Action must be 'ADD' or 'DEDUCT'");
  await tx(async c => {
    const u = (await c.query('SELECT balance FROM users WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
    if (!u) throw new Biz('User not found', 404);
    const before = num(u.balance), after = action === 'DEDUCT' ? Math.max(0, r2(before - amt)) : r2(before + amt), id = newId('ADJ');
    await c.query('UPDATE users SET balance=$1 WHERE user_id=$2', [after, uid]);
    await c.query(`INSERT INTO transactions (txn_id,user_id,type,amount,status,remarks,processed_by) VALUES ($1,$2,'ADJUSTMENT',$3,'APPROVED',$4,$5)`,
      [id, uid, amt, String(req.body.reason || `${action} by admin`).slice(0, 200), req.actor]);
    await audit(c, uid, `BALANCE_${action}`, amt, before, after, id);
  });
  alog(req, 'adjust-balance', `${uid} ${action} ${amt} ${req.body.reason || ''}`);
  res.json({ success: true, message: `Adjusted ${amt} ETB (${action}) for ${uid}` });
}));

// Pays pct of each player's NEW net loss since the previous cashback (so it can never double-pay), with 1x wagering.
async function runCashback(pct, cutoff, actor, label) {
  return tx(async c => {
    const rows = (await c.query(`SELECT user_id,balance,(total_wagered-total_won) AS net_loss,COALESCE(cashback_settled_loss,0) AS settled FROM users
      WHERE (total_wagered-total_won-COALESCE(cashback_settled_loss,0))>=$1 AND LOWER(status)='active' ORDER BY user_id FOR UPDATE`, [cutoff])).rows;
    let n = 0, total = 0; const items = [];
    for (const u of rows) {
      const fresh = num(u.net_loss) - num(u.settled), cb = r2(fresh * pct); if (cb <= 0) continue;
      const before = num(u.balance), after = r2(before + cb), id = newId('CB');
      await c.query(`UPDATE users SET balance=$1,bonus_balance=bonus_balance+$2,wager_requirement_left=wager_requirement_left+$2,cashback_settled_loss=$3,last_cashback_at=NOW() WHERE user_id=$4`, [after, cb, num(u.net_loss), u.user_id]);
      await c.query(`INSERT INTO transactions (txn_id,user_id,type,amount,status,remarks,processed_by) VALUES ($1,$2,'BONUS',$3,'APPROVED',$4,$5)`, [id, u.user_id, cb, label, actor]);
      await audit(c, u.user_id, 'CASHBACK', cb, before, after, id);
      n++; total += cb; items.push({ uid: u.user_id, cb, loss: r2(fresh) });
    }
    await c.query('UPDATE casino_vault SET total_bonus_awarded=total_bonus_awarded+$1 WHERE id=1', [total]);
    return { n, total, items };
  });
}
async function notifyCashback(items, percent) {   // not inside the transaction; paced to stay under Telegram's rate limit
  for (const it of items.slice(0, 5000)) {
    await notify(it.uid, `Cashback: ${fmt(it.cb)} ETB (${percent}% of your net loss of ${fmt(it.loss)} ETB) was added to your balance. 1x wagering applies.`);
    await new Promise(r => setTimeout(r, 60));
  }
}
app.post('/api/admin/distribute-cashback', admin, h(async (req, res) => {
  const pct = Number(req.body.percentage) / 100, cutoff = Number(req.body.minLoss || 100);
  if (!(pct > 0 && pct <= 0.5)) throw new Biz('Percentage must be between 1 and 50');
  const out = await runCashback(pct, cutoff, req.actor, `${req.body.percentage}% cashback`);
  alog(req, 'cashback', `${req.body.percentage}% -> ${out.n} players, ${out.total.toFixed(2)} ETB`);
  notifyCashback(out.items, req.body.percentage);
  res.json({ success: true, message: `Distributed ${out.total.toFixed(2)} ETB cashback to ${out.n} players (1x wagering applies)` });
}));

const CASHBACK = { auto: ENV.CASHBACK_AUTO !== '0', percent: Math.min(50, Math.max(1, Number(ENV.CASHBACK_PERCENT || 10))), hour: Math.min(23, Math.max(0, Number(ENV.CASHBACK_HOUR || 10))), minLoss: Number(ENV.CASHBACK_MIN_LOSS || 100) };
let cashbackFailedAt = 0;
async function cashbackTick() {
  if (!CASHBACK.auto || Date.now() - cashbackFailedAt < 10 * 60e3) return;
  const last = (await pool.query(`SELECT value FROM system_settings WHERE key='cashback_last_run'`)).rows[0];
  const key = cashbackDue(new Date(), last ? last.value : '', CASHBACK.hour); if (!key) return;
  await pool.query(`INSERT INTO system_settings (key,value) VALUES ('cashback_last_run','') ON CONFLICT (key) DO NOTHING`);
  const claim = await pool.query(`UPDATE system_settings SET value=$1 WHERE key='cashback_last_run' AND value<>$1`, [key]);   // atomic: only one run per day
  if (claim.rowCount !== 1) return;
  try {
    const base = await pool.query(`INSERT INTO system_settings (key,value) VALUES ('cashback_baseline','done') ON CONFLICT (key) DO NOTHING RETURNING key`);
    if (base.rowCount === 1) {   // first ever run: today's starting line, so old losses are never paid retroactively
      await pool.query(`UPDATE users SET cashback_settled_loss=GREATEST(0,total_wagered-total_won)`);
      console.log('Auto cashback: starting line set, the first payout is tomorrow'); return;
    }
    const out = await runCashback(CASHBACK.percent / 100, CASHBACK.minLoss, 'AUTO', `${CASHBACK.percent}% daily cashback`);
    console.log(`Auto cashback ${key}: ${out.total.toFixed(2)} ETB to ${out.n} players`);
    notifyAdmins(`Daily cashback paid: ${fmt(out.total)} ETB to ${out.n} players (${CASHBACK.percent}%)`);
    notifyCashback(out.items, CASHBACK.percent);
  } catch (e) {
    cashbackFailedAt = Date.now(); console.error('auto cashback failed:', e.message);
    await pool.query(`UPDATE system_settings SET value='' WHERE key='cashback_last_run' AND value=$1`, [key]).catch(() => {});
  }
}
setInterval(() => cashbackTick().catch(e => console.error('cashback tick:', e.message)), 30e3).unref();

app.post('/api/admin/create-promo', admin, h(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 40), amt = r2(req.body.bonusAmount), max = parseInt(req.body.maxUses || 100, 10);
  if (!code || !(amt > 0 && amt <= 10000) || !(max > 0)) throw new Biz('Valid code, bonus amount and max uses required');
  await pool.query('INSERT INTO promo_codes (code,bonus_amount,max_uses) VALUES ($1,$2,$3)', [code, amt, max]);
  alog(req, 'create-promo', `${code} +${amt} x${max}`);
  res.json({ success: true, message: `Promo ${code} created (+${amt} ETB)` });
}));
app.post('/api/admin/reward-users', admin, h(async (req, res) => {
  const ids = Array.isArray(req.body.userIds) ? [...new Set(req.body.userIds.map(String))].slice(0, 500) : [], amt = r2(req.body.rewardAmount);
  if (!ids.length || !(amt > 0 && amt <= 1000)) throw new Biz('Valid user IDs (max 500) and amount (max 1000) required');
  const wr = r2(amt * CONFIG.WAGER_REQ_MULT);
  const n = await tx(async c => {
    let count = 0;
    for (const uid of ids) {
      const r = await c.query(`UPDATE users SET balance=balance+$1,bonus_balance=bonus_balance+$1,wager_requirement_left=wager_requirement_left+$2 WHERE user_id=$3 RETURNING balance`, [amt, wr, uid]);
      if (r.rows.length) { const a = num(r.rows[0].balance); await audit(c, uid, 'BATCH_REWARD', amt, r2(a - amt), a, 'ADMIN_BATCH'); count++; }
    }
    await c.query('UPDATE casino_vault SET total_bonus_awarded=total_bonus_awarded+$1 WHERE id=1', [amt * count]);
    return count;
  });
  alog(req, 'reward-users', `${n} players x ${amt}`);
  res.json({ success: true, message: `Rewarded ${n} players with ${amt} ETB each (wager ${wr} ETB)` });
}));
app.post('/api/admin/update-settings', admin, h(async (req, res) => {
  const norm = v => { const x = parseFloat(v); return x > 1 ? x / 100 : x; };
  const { targetRtp, agentCommission, kenoRtp } = req.body;
  if (kenoRtp !== undefined) {
    const v = norm(kenoRtp); if (!(v >= 0.5 && v <= 0.99)) throw new Biz('Keno RTP must be between 50% and 99%');
    CONFIG.KENO_RTP = v; await pool.query(`INSERT INTO system_settings (key,value) VALUES ('keno_rtp',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [String(v)]);
  }
  if (targetRtp !== undefined) {
    const v = norm(targetRtp); if (!(v >= 0.5 && v <= 0.99)) throw new Biz('RTP must be between 50% and 99%');
    CONFIG.TARGET_RTP = v; await pool.query(`INSERT INTO system_settings (key,value) VALUES ('target_rtp',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [String(v)]);
  }
  if (agentCommission !== undefined) {
    const v = norm(agentCommission); if (!(v >= 0 && v <= 0.2)) throw new Biz('Commission must be between 0% and 20%');
    CONFIG.AGENT_COMMISSION = v; await pool.query(`INSERT INTO system_settings (key,value) VALUES ('agent_commission',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [String(v)]);
  }
  alog(req, 'update-settings', JSON.stringify({ targetRtp, agentCommission }));
  res.json({ success: true, message: 'Settings saved' });
}));
app.post('/api/admin/user-status', admin, h(async (req, res) => {
  const status = String(req.body.status || '').toLowerCase();
  if (!['active', 'suspended', 'banned'].includes(status)) throw new Biz('Invalid status');
  const r = await pool.query('UPDATE users SET status=$1 WHERE user_id=$2', [status, String(req.body.userId)]);
  if (!r.rowCount) throw new Biz('User not found', 404);
  alog(req, 'user-status', `${req.body.userId} -> ${status}`); res.json({ success: true, message: `User status changed to ${status}` });
}));

async function shutdown() { console.log('Shutting down, saving stats...'); try { await flushVault(); } catch (e) {} process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
const PORT = ENV.PORT || 3000;
ensureSchema()
  .then(closeLegacyRounds)
  .then(loadSettings)
  .then(refreshVaultCache)
  .then(() => gameShared.crashEngine.seedHistories().catch(() => {}))
  .then(() => runTwelveHourAuditAndPrune(pool).catch(e => console.warn('startup 12h audit:', e.message)))
  .finally(() => server.listen(PORT, '0.0.0.0', () => console.log(`Hulu Bet server on 0.0.0.0:${PORT}`)));
