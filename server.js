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
const compression = require('compression');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();
const { createMockPool } = require('./mock-db');
const { r2, num, cashbackDue } = require('./lib/game-math');
const { createTtlCache, createRateTracker, createChatBuffer } = require('./lib/cache');
const { SPIN_SLICES, rollSpinPrize, getSpinAvailability, computeClaimableCashback } = require('./lib/bonus-engine');
const { runTwelveHourAuditAndPrune, getRetentionStats, getReports12h } = require('./lib/audit-rollup');
const { registerTelegramBot } = require('./lib/telegram-bot');
const { mountAllGames, CRASH_GAMES } = require('./games');
const { registerSportsbook } = require('./Sportserver');
const { createSmsVerifyService, parsers: smsParsers } = require('./lib/sms-verify-server');
const { normalizePeriod, periodCutoffMs, buildBestWinsPeriods, buildUserHistorySummary } = require('./lib/stats-engine');

const ENV = process.env;
const HAS_DB = Boolean(ENV.DATABASE_URL);
const HAS_BOT_TOKEN = Boolean(ENV.BOT_TOKEN);
const RAW_ADMIN_PIN = String(ENV.ADMIN_PIN || '').trim();
const ADMIN_PIN = RAW_ADMIN_PIN.length >= 4 ? RAW_ADMIN_PIN : '12345678';
if (!HAS_DB) console.warn('[AI Studio] DATABASE_URL not set — using in-memory mock database');
if (!HAS_BOT_TOKEN) console.warn('[AI Studio] BOT_TOKEN not set — demo browser session enabled');
if (RAW_ADMIN_PIN.length < 4) console.warn('[AI Studio] ADMIN_PIN not set (or <4 chars) — using default demo PIN 12345678');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, perMessageDeflate: false });
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-token', 'x-telegram-init-data', 'x-verify-token', 'x-webhook-token', 'Authorization']
}));
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));

const pool = HAS_DB
  ? new Pool({
      connectionString: ENV.DATABASE_URL.replace(/[?&]channel_binding=require/, ''),
      ssl: { rejectUnauthorized: false },
      max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000, statement_timeout: 15000
    })
  : createMockPool();
if (HAS_DB) pool.on('error', e => console.error('pg idle client error:', e.message));

const cache = createTtlCache({ maxEntries: 300 });
const cacheInvalidate = p => cache.invalidate(p);
const rateTracker = createRateTracker({ maxKeys: 10000 });
const chatBuffer = createChatBuffer(30);
let schemaReady = false;
let chatSendCount = 0;

const CONFIG = {
  TARGET_RTP: 0.85, AGENT_COMMISSION: 0.02, WELCOME_BONUS: 20, REFERRAL_BONUS: 50,
  MIN_FIRST_DEP: 50, WAGER_REQ_MULT: 3, MIN_DEP: 50, MAX_DEP: 100000, MIN_WTH: 100, MAX_WTH: 50000,
  KENO_RTP: 0.70,   // Keno return-to-player (other games follow TARGET_RTP)
  MIN_BET: 1, MAX_BET: 1000, MAX_PAYOUT: 20000, SAFETY_BUFFER: 50000, MAX_CRASH: 100,
  DAILY_WTH_LIMIT: 100000, MAX_PENDING_WTH: 2, REVIEW_AMOUNT: 10000, DEP_EXPIRE_HOURS: 24
};
const _cbPct = parseFloat(ENV.CASHBACK_PERCENT);
const _cbHr = parseFloat(ENV.CASHBACK_HOUR);
const _cbMin = parseFloat(ENV.CASHBACK_MIN_LOSS);
const CASHBACK = {
  auto: ENV.CASHBACK_AUTO !== '0',
  percent: Math.min(50, Math.max(1, Number.isFinite(_cbPct) ? (_cbPct > 0 && _cbPct < 1 ? _cbPct * 100 : _cbPct) : 10)),
  hour: Math.min(23, Math.max(0, Number.isFinite(_cbHr) ? _cbHr : 10)),
  minLoss: Math.max(10, Number.isFinite(_cbMin) ? _cbMin : 100)
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
let vaultBalanceCache = 0;   // used only for the "is the bankroll healthy" check (SAFETY_BUFFER)
async function flushVault() {
  const p = { ...vaultPending };
  if (!Object.values(p).some(v => v)) return;
  for (const k in vaultPending) vaultPending[k] = 0;
  try {
    const r = await pool.query(`UPDATE casino_vault SET vault_balance=vault_balance+$1,total_wagered=total_wagered+$2,total_payouts=total_payouts+$3,
      gross_profit=gross_profit+$4,total_bonus_awarded=total_bonus_awarded+$5,updated_at=NOW() WHERE id=1 RETURNING vault_balance`, [p.bal, p.wagered, p.payouts, p.profit, p.bonus]);
    if (r.rows && r.rows[0] && r.rows[0].vault_balance !== undefined) {
      vaultBalanceCache = num(r.rows[0].vault_balance);
    }
  } catch (e) { for (const k in p) vaultPending[k] += p[k]; console.error('vault flush failed, will retry:', e.message); }
}
setInterval(flushVault, 3000).unref();
async function refreshVaultCache() { try { const r = await pool.query('SELECT vault_balance FROM casino_vault WHERE id=1'); vaultBalanceCache = num(r.rows[0]?.vault_balance); } catch (e) {} }
setInterval(refreshVaultCache, 60e3).unref();
const bankrollSafe = () => vaultBalanceCache + vaultPending.bal >= CONFIG.SAFETY_BUFFER;

// Active crash bets kept in memory: status polling (4/s per player) no longer touches the database.
// The database stays the source of truth; after a restart the cache refills itself on the first poll.
const flights = new Map();   // betId -> { uid, cp, auto, start(ms) }

const limit = (name, max, ms) => (req, res, next) => {
  const k = name + ':' + (req.tg ? 'u' + req.tg.id : req.ip);
  if (!rateTracker.hit(k, max, ms).allowed) return res.status(429).json({ success: false, message: 'Too many requests, slow down' });
  next();
};
setInterval(() => {
  const n = Date.now();
  rateTracker.cleanup(n);
  for (const [ip, f] of adminFails) if (n - f.t >= 15 * 60e3) adminFails.delete(ip);
}, 600e3).unref();

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
    const r = rateTracker.hit('authfail:' + req.ip, 60, 60e3);
    return res.status(r.allowed ? 401 : 429).json({ success: false, message: r.allowed ? 'Session expired. Please reopen the app from Telegram.' : 'Too many failed attempts' });
  }
  req.tg = { id: String(u.id), username: u.username || '', name: [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Player' };
  next();
}

// ---- Admin auth: constant-time compare + lockout after 5 wrong tries / 15 min ----
const adminFails = new Map();
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function adminAuth(req, res, next) {
  const f = adminFails.get(req.ip) || { n: 0, t: 0 }, fresh = Date.now() - f.t < 15 * 60e3;
  if (fresh && f.n >= 5) return res.status(429).json({ success: false, message: 'Locked for 15 minutes after 5 failed attempts.' });
  const given = String(req.headers['x-admin-token'] || req.body?.pin || (ENV.ALLOW_QUERY_PIN === '1' ? req.query.pin : '') || '').trim();
  if (!given) return res.status(403).json({ success: false, message: 'Please enter your Admin PIN.' });
  if (!crypto.timingSafeEqual(sha(given), sha(ADMIN_PIN))) {
    const nextN = (fresh ? f.n : 0) + 1;
    adminFails.set(req.ip, { n: nextN, t: Date.now() });
    const left = Math.max(0, 5 - nextN);
    return res.status(403).json({ success: false, message: left > 0 ? `Invalid Admin PIN! (${left} tries left)` : 'Invalid Admin PIN! Locked for 15 minutes.' });
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
    `CREATE TABLE IF NOT EXISTS chat_messages (id BIGSERIAL PRIMARY KEY,user_id VARCHAR(64),username VARCHAR(128),message TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS game_12h_reports (id BIGSERIAL PRIMARY KEY,period_start TIMESTAMPTZ,period_end TIMESTAMPTZ,game_name VARCHAR(64),total_bets INTEGER,won_bets INTEGER,lost_bets INTEGER,total_wagered NUMERIC(14,2),total_payout NUMERIC(14,2),net_profit NUMERIC(14,2),actual_rtp NUMERIC(6,2),unique_players INTEGER,audit_entries_purged INTEGER DEFAULT 0,created_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS promo_codes (code VARCHAR(64) PRIMARY KEY,bonus_amount NUMERIC(14,2) NOT NULL,max_uses INTEGER DEFAULT 100,times_used INTEGER DEFAULT 0,is_active BOOLEAN DEFAULT TRUE,created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS bonus_amount NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS max_uses INTEGER DEFAULT 100, ADD COLUMN IF NOT EXISTS times_used INTEGER DEFAULT 0, ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`,
    `CREATE TABLE IF NOT EXISTS promo_redemptions (id BIGSERIAL PRIMARY KEY,user_id VARCHAR(64) NOT NULL,code VARCHAR(64) NOT NULL,amount_awarded NUMERIC(14,2) DEFAULT 0,created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE promo_redemptions ADD COLUMN IF NOT EXISTS amount_awarded NUMERIC(14,2) DEFAULT 0`,
    `INSERT INTO promo_codes (code,bonus_amount,max_uses) VALUES ('HULU50',50,100) ON CONFLICT (code) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS sports_bets (ticket_id VARCHAR(64) PRIMARY KEY,bet_id VARCHAR(64),user_id VARCHAR(64),username VARCHAR(128),match_id VARCHAR(64),match_title TEXT,market TEXT,odds NUMERIC(8,2),stake NUMERIC(14,2),potential_win NUMERIC(14,2),cashout_value NUMERIC(14,2),payout NUMERIC(14,2) DEFAULT 0,status VARCHAR(24) DEFAULT 'IN_PLAY',created_at TIMESTAMPTZ DEFAULT NOW(),settled_at TIMESTAMPTZ)`,
    `ALTER TABLE sports_bets ADD COLUMN IF NOT EXISTS ticket_id VARCHAR(64), ADD COLUMN IF NOT EXISTS bet_id VARCHAR(64), ADD COLUMN IF NOT EXISTS user_id VARCHAR(64), ADD COLUMN IF NOT EXISTS username VARCHAR(128), ADD COLUMN IF NOT EXISTS match_id VARCHAR(64), ADD COLUMN IF NOT EXISTS match_title TEXT, ADD COLUMN IF NOT EXISTS market TEXT, ADD COLUMN IF NOT EXISTS odds NUMERIC(8,2), ADD COLUMN IF NOT EXISTS stake NUMERIC(14,2), ADD COLUMN IF NOT EXISTS potential_win NUMERIC(14,2), ADD COLUMN IF NOT EXISTS cashout_value NUMERIC(14,2), ADD COLUMN IF NOT EXISTS payout NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS status VARCHAR(24) DEFAULT 'IN_PLAY', ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(), ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_sports_ticket ON sports_bets (ticket_id) WHERE ticket_id IS NOT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS wager_requirement_left NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS total_won NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS total_wagered NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS total_deposited NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS referrer_id VARCHAR(64) DEFAULT '', ADD COLUMN IF NOT EXISTS referral_paid BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS last_cashback_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS last_spin_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS cashback_settled_loss NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ`,
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
    `CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions (type, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_users_referrer ON users (referrer_id) WHERE referrer_id <> ''`,
    `CREATE INDEX IF NOT EXISTS idx_bets_game_status_created ON universal_bets (game_name, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_bets_won_payout ON universal_bets (created_at DESC) WHERE status='WON' AND payout>=100`,
    `CREATE INDEX IF NOT EXISTS idx_bets_inflight_start ON universal_bets (user_id, flight_start) WHERE status='IN_FLIGHT'`,
    `CREATE INDEX IF NOT EXISTS idx_sports_status_match ON sports_bets (status, match_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tx_user_created ON transactions (user_id, created_at DESC)`
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
  await smsVerifier.ensureSchemaAndToken();
}
async function loadSettings() {
  const norm = v => { const x = parseFloat(v); return x > 1 ? x / 100 : x; };
  if (ENV.KENO_RTP) CONFIG.KENO_RTP = norm(ENV.KENO_RTP) || CONFIG.KENO_RTP;
  try {
    const r = await pool.query('SELECT key,value FROM system_settings');
    r.rows.forEach(({ key, value }) => {
      if (key === 'target_rtp' && Number.isFinite(norm(value))) CONFIG.TARGET_RTP = norm(value);
      if (key === 'keno_rtp' && Number.isFinite(norm(value))) CONFIG.KENO_RTP = norm(value);
      if (key === 'agent_commission' && Number.isFinite(norm(value))) CONFIG.AGENT_COMMISSION = norm(value);
      if (key === 'welcome_bonus' && Number.isFinite(parseFloat(value))) CONFIG.WELCOME_BONUS = parseFloat(value);
      if (key === 'referral_bonus' && Number.isFinite(parseFloat(value))) CONFIG.REFERRAL_BONUS = parseFloat(value);
      if (key === 'cashback_percent') { const v = parseFloat(value); if (Number.isFinite(v) && v >= 1 && v <= 50) CASHBACK.percent = v; }
      if (key === 'cashback_min_loss') { const v = parseFloat(value); if (Number.isFinite(v) && v >= 10) CASHBACK.minLoss = v; }
    });
  } catch (e) { console.warn('settings not loaded:', e.message); }
  console.log(`Settings: RTP=${CONFIG.TARGET_RTP * 100}% (Keno ${CONFIG.KENO_RTP * 100}%) commission=${CONFIG.AGENT_COMMISSION * 100}% welcome=${CONFIG.WELCOME_BONUS} ref=${CONFIG.REFERRAL_BONUS} cashback=${CASHBACK.percent}%`);
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

// ---- Unified payment gateway (Telebirr / CBE): uses external verify server when configured, or built-in SMS ledger as fallback
const AUTO_DEP_MAX = Number(ENV.AUTO_DEP_MAX || 2000);   // verified deposits above this wait for a cashier instead of auto-crediting
const DEFAULT_VERIFI_URL = 'https://verifi-server-milr.onrender.com/api/verify';
const VERIFI_URL = String(ENV.VERIFI_URL || DEFAULT_VERIFI_URL).trim();
const USE_EXTERNAL_VERIFI = ENV.USE_EXTERNAL_VERIFI === '1' || (ENV.USE_EXTERNAL_VERIFI !== '0' && Boolean(ENV.VERIFI_TOKEN));
const smsVerifier = createSmsVerifyService({ pool, env: ENV, admin, h });
async function verifyWithGateway(ref, amount) {
  if (USE_EXTERNAL_VERIFI) {
    if (!ENV.VERIFI_TOKEN) throw new Biz('Automatic verification is not available right now. Use "Send Deposit Request".', 503);
    const u = new URL(VERIFI_URL);
    u.searchParams.set('token', ENV.VERIFI_TOKEN); u.searchParams.set('ref', ref); u.searchParams.set('amount', String(amount));
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 35000);
    try {
      const r = await fetch(u, { signal: ctl.signal }), text = await r.text();
      if (r.status === 401 || r.status === 403) {
        throw new Biz('Verification gateway rejected server token. Contact support or use "Send Deposit Request".', 503);
      }
      let body = {}; try { body = JSON.parse(text); } catch (e) {}
      return { ok: r.ok, body, raw: text.slice(0, 200) };
    } finally { clearTimeout(timer); }
  }
  const body = await smsVerifier.verifyPaymentDirect(ref, amount);
  return { ok: true, body, raw: '' };
}
const gatewayVerified = b => !!b && (String(b.status || '').toLowerCase() === 'verified' || b.verified === true);
const gatewayAmount = b => { const n = Number(b && (b.amount ?? (b.data && b.data.amount))); return Number.isFinite(n) && n > 0 ? n : null; };

// ---------------------------------------------------------------- static frontend + modular games + sportsbook + telegram bot
app.get('/', (_q, res) => res.sendFile(path.join(__dirname, 'homepage.html'), { maxAge: 60 * 1000 }));
app.get(['/admin', '/betadmin', '/betadmin.html'], (_q, res) => res.sendFile(path.join(__dirname, 'betadmin.html'), { maxAge: 60 * 1000 }));
app.get('/homepage.html', (_q, res) => res.sendFile(path.join(__dirname, 'homepage.html'), { maxAge: 60 * 1000 }));
app.get('/game-bridge.js', (_q, res) => res.sendFile(path.join(__dirname, 'game-bridge.js'), { maxAge: 300 * 1000 }));

// ---------------------------------------------------------------- public
app.get('/api/ping', (_q, res) => res.json({ status: 'OK', timestamp: Date.now() }));
app.get('/api/heartbeat', (_q, res) => res.json({ status: 'ALIVE' }));
app.get('/api/public/config', (_q, res) => res.json({
  success: true,
  welcomeBonus: CONFIG.WELCOME_BONUS,
  referralBonus: CONFIG.REFERRAL_BONUS,
  cashbackPercent: CASHBACK.percent,
  cashbackMinLoss: CASHBACK.minLoss,
  minBet: CONFIG.MIN_BET,
  maxBet: CONFIG.MAX_BET,
  minDep: CONFIG.MIN_DEP,
  minWth: CONFIG.MIN_WTH,
  botUsername: ENV.BOT_USERNAME || 'Hulubetethbot'
}));
smsVerifier.mountRoutes(app);

app.get('/api/agents', h(async (_q, res) => {
  const agents = await cache.getOrLoad('agents:list', 60000, async () => {
    const r = await pool.query('SELECT telegram_username FROM agents');
    return r.rows;
  });
  res.json({ success: true, agents });
}));
app.get('/api/user/history', userAuth, limit('uhist', 120, 60e3), h(async (req, res) => {
  const uid = req.tg.id;
  const period = normalizePeriod(req.query.period, 'all');
  const payload = await cache.getOrLoad(`userhist:${uid}:${period}`, 15000, async () => {
    const cutoff = new Date(periodCutoffMs(period));
    const [casinoRes, sportsRes] = await Promise.all([
      pool.query(
        `SELECT bet_id,game_name,bet_amount,multiplier,payout,status,game_data,created_at FROM universal_bets WHERE user_id=$1 AND status<>'IN_FLIGHT' AND created_at>=$2 ORDER BY created_at DESC LIMIT 60`,
        [uid, cutoff]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT COALESCE(ticket_id,bet_id) AS bet_id,match_title,market,odds,stake,payout,status,created_at FROM sports_bets WHERE user_id=$1 AND status<>'IN_PLAY' AND created_at>=$2 ORDER BY created_at DESC LIMIT 30`,
        [uid, cutoff]
      ).catch(() => ({ rows: [] }))
    ]);

    const casinoItems = casinoRes.rows.map(b => {
      const gd = parseJson(b.game_data);
      const amount = num(b.bet_amount);
      const win = num(b.payout);
      return {
        betId: b.bet_id,
        roundId: gd.roundId || b.bet_id,
        game: b.game_name,
        betAmount: amount,
        amount,
        multiplier: num(b.multiplier),
        payout: win,
        win,
        status: b.status,
        createdAt: b.created_at,
        time: new Date(b.created_at).getTime(),
        picks: Array.isArray(gd.picks) ? gd.picks : undefined,
        drawnNumbers: Array.isArray(gd.drawnNumbers) ? gd.drawnNumbers : undefined,
        hits: gd.hits !== undefined ? Number(gd.hits) : undefined
      };
    });

    const sportsItems = sportsRes.rows.map(s => {
      const amount = num(s.stake);
      const win = num(s.payout);
      return {
        betId: s.bet_id,
        roundId: s.bet_id,
        game: 'Sportsbook',
        matchTitle: s.match_title,
        market: s.market,
        betAmount: amount,
        amount,
        multiplier: num(s.odds),
        payout: win,
        win,
        status: s.status,
        createdAt: s.created_at,
        time: new Date(s.created_at).getTime()
      };
    });

    const combined = [...casinoItems, ...sportsItems].sort((a, b) => b.time - a.time);
    const summary = buildUserHistorySummary(combined);
    return {
      success: true,
      period,
      summary,
      history: combined.slice(0, 40)
    };
  });
  res.json(payload);
}));

// ---- Bonuses & Live Chat ----
app.get('/api/bonus/status', userAuth, limit('bonusstat', 240, 60e3), h(async (req, res) => {
  const uid = req.tg.id;
  const ur = await pool.query(
    `SELECT balance,bonus_balance,wager_requirement_left,total_wagered,total_won,cashback_settled_loss,last_spin_at,
            (SELECT COUNT(*)::int FROM users r WHERE r.referrer_id=$1) AS referral_count
     FROM users WHERE user_id=$1`,
    [uid]
  );
  if (!ur.rows.length) throw new Biz('User not found', 404);
  const u = ur.rows[0];
  res.json({
    success: true,
    balance: num(u.balance),
    bonusBalance: num(u.bonus_balance),
    wagerRequirementLeft: num(u.wager_requirement_left),
    welcomeBonus: CONFIG.WELCOME_BONUS,
    referralBonus: CONFIG.REFERRAL_BONUS,
    referralCount: Number(u.referral_count || 0),
    cashback: computeClaimableCashback({
      totalWagered: u.total_wagered,
      totalWon: u.total_won,
      settledLoss: u.cashback_settled_loss,
      percent: CASHBACK.percent,
      minLoss: CASHBACK.minLoss
    }),
    spin: {
      ...getSpinAvailability(u.last_spin_at),
      slices: SPIN_SLICES.map(s => ({ label: s.label, amount: s.amount }))
    }
  });
}));

app.post('/api/bonus/lucky-spin', userAuth, limit('spin', 20, 60e3), h(async (req, res) => {
  const uid = req.tg.id;
  const out = await tx(async c => {
    const u = await lockUser(c, uid);
    const avail = getSpinAvailability(u.last_spin_at);
    if (!avail.canSpin) {
      throw new Biz('Daily Lucky Spin already claimed. Come back after 24h cooldown.', 429);
    }
    const prize = rollSpinPrize();
    const before = num(u.balance);
    const after = r2(before + prize.amount);
    const wagerAdded = prize.amount > 0 ? r2(prize.amount * CONFIG.WAGER_REQ_MULT) : 0;

    if (prize.amount > 0) {
      await c.query(
        `UPDATE users SET last_spin_at=NOW(),balance=$1,bonus_balance=bonus_balance+$2,wager_requirement_left=wager_requirement_left+$3 WHERE user_id=$4`,
        [after, prize.amount, wagerAdded, uid]
      );
      const id = newId('SPN');
      await c.query(
        `INSERT INTO transactions (txn_id,user_id,type,amount,status,remarks,processed_by) VALUES ($1,$2,'BONUS',$3,'APPROVED','Daily Lucky Spin','AUTO')`,
        [id, uid, prize.amount]
      );
      await audit(c, uid, 'LUCKY_SPIN', prize.amount, before, after, id);
    } else {
      await c.query(`UPDATE users SET last_spin_at=NOW() WHERE user_id=$1`, [uid]);
    }
    return { prize, after, wagerAdded, nextSpinAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
  });

  if (out.prize.amount > 0) vaultAdd({ bonus: out.prize.amount });
  res.json({
    success: true,
    sliceIndex: out.prize.sliceIndex,
    amount: out.prize.amount,
    label: out.prize.label,
    newBalance: out.after,
    wagerAdded: out.wagerAdded,
    nextSpinAt: out.nextSpinAt
  });
}));

app.post('/api/bonus/claim-cashback', userAuth, limit('claimcb', 15, 60e3), h(async (req, res) => {
  const uid = req.tg.id;
  const out = await tx(async c => {
    const u = await lockUser(c, uid);
    const calc = computeClaimableCashback({
      totalWagered: u.total_wagered,
      totalWon: u.total_won,
      settledLoss: u.cashback_settled_loss,
      percent: CASHBACK.percent,
      minLoss: CASHBACK.minLoss
    });
    if (!calc.eligible || calc.cashbackAmount <= 0) {
      const need = r2(Math.max(0, calc.minLoss - calc.unclaimedLoss));
      throw new Biz(`Need ${need.toFixed(2)} ETB more net loss to reach minimum ${calc.minLoss} ETB cashback threshold.`);
    }
    const cb = calc.cashbackAmount;
    const before = num(u.balance);
    const after = r2(before + cb);
    const id = newId('CB');
    await c.query(
      `UPDATE users SET balance=$1,bonus_balance=bonus_balance+$2,wager_requirement_left=wager_requirement_left+$2,cashback_settled_loss=$3,last_cashback_at=NOW() WHERE user_id=$4`,
      [after, cb, calc.totalNetLoss, uid]
    );
    await c.query(
      `INSERT INTO transactions (txn_id,user_id,type,amount,status,remarks,processed_by) VALUES ($1,$2,'BONUS',$3,'APPROVED',$4,'SELF_CLAIM')`,
      [id, uid, cb, `${calc.percent}% cashback claim`]
    );
    await audit(c, uid, 'CASHBACK_CLAIM', cb, before, after, id);
    return { cb, after, unclaimedCleared: calc.unclaimedLoss };
  });

  vaultAdd({ bonus: out.cb });
  res.json({
    success: true,
    cashbackAmount: out.cb,
    newBalance: out.after,
    unclaimedLossCleared: out.unclaimedCleared,
    message: `+${out.cb.toFixed(2)} ETB cashback added (1x wagering applies)`
  });
}));

async function hydrateChatBuffer() {
  try {
    const r = await pool.query(`SELECT id,user_id,username,message,created_at FROM chat_messages ORDER BY id DESC LIMIT 30`);
    chatBuffer.seed(r.rows.reverse().map(m => ({
      id: m.id,
      userId: m.user_id,
      username: m.username || 'Player',
      message: m.message,
      createdAt: m.created_at
    })));
  } catch (_) {}
}

app.get('/api/chat/messages', limit('chatread', 120, 60e3), h(async (_req, res) => {
  if (!chatBuffer.isHydrated()) await hydrateChatBuffer();
  res.json({ success: true, messages: chatBuffer.list() });
}));

app.post('/api/chat/send', userAuth, limit('chat', 15, 60e3), h(async (req, res) => {
  const clean = String(req.body?.message || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
  if (!clean) throw new Biz('Enter a message');
  const uname = req.tg.name || (req.tg.username ? '@' + req.tg.username : mask(req.tg.id));
  const r = await pool.query(
    `INSERT INTO chat_messages (user_id,username,message) VALUES ($1,$2,$3) RETURNING id,user_id,username,message,created_at`,
    [req.tg.id, uname.slice(0, 48), clean]
  );
  chatSendCount += 1;
  if (chatSendCount % 25 === 0) {
    pool.query(`DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 100)`).catch(() => {});
  }
  const row = r.rows[0] || { id: Date.now(), user_id: req.tg.id, username: uname, message: clean, created_at: new Date() };
  const msgObj = {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    message: row.message,
    createdAt: row.created_at
  };
  chatBuffer.push(msgObj);
  io.emit('chat:msg', msgObj);
  res.json({ success: true, msg: msgObj });
}));

app.get('/api/public/feed', limit('feed', 240, 60e3), h(async (req, res) => {
  const game = CRASH_GAMES.includes(req.query.game) ? req.query.game : 'JetX';
  const payload = await cache.getOrLoad(`feed:${game}`, 5000, async () => {
    const [w, c] = await Promise.all([
      pool.query(`SELECT username,game_name,payout,multiplier FROM universal_bets WHERE status='WON' AND payout>=100 ORDER BY created_at DESC LIMIT 15`),
      pool.query(`SELECT game_data FROM universal_bets WHERE game_name=$1 AND status IN ('WON','LOST') ORDER BY created_at DESC LIMIT 30`, [game])
    ]);
    const seen = new Set(), crashes = [];
    for (const r of c.rows) { const g = parseJson(r.game_data); if (g.roundId && !seen.has(g.roundId)) { seen.add(g.roundId); crashes.push(g.crashPoint); } if (crashes.length >= 15) break; }
    return { success: true, wins: w.rows.map(r => ({ user: mask(r.username), game: r.game_name, win: num(r.payout), mult: num(r.multiplier) })), crashes };
  });
  res.json(payload);
}));

app.get('/api/public/best-wins', limit('bestwins', 120, 60e3), h(async (_req, res) => {
  const payload = await cache.getOrLoad('public:best-wins', 60000, async () => {
    const [gRes, rRes, sRes, wRes] = await Promise.all([
      pool.query(`SELECT game_name,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') AS b1,
        COUNT(*) FILTER (WHERE status='WON' AND created_at >= NOW() - INTERVAL '1 day') AS w1,
        COALESCE(SUM(bet_amount) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day'), 0) AS wag1,
        COALESCE(SUM(payout) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day'), 0) AS pay1,
        COALESCE(MAX(payout) FILTER (WHERE status='WON' AND created_at >= NOW() - INTERVAL '1 day'), 0) AS maxp1,
        COALESCE(MAX(multiplier) FILTER (WHERE status='WON' AND created_at >= NOW() - INTERVAL '1 day'), 0) AS maxm1,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS b7,
        COUNT(*) FILTER (WHERE status='WON' AND created_at >= NOW() - INTERVAL '7 days') AS w7,
        COALESCE(SUM(bet_amount) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0) AS wag7,
        COALESCE(SUM(payout) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0) AS pay7,
        COALESCE(MAX(payout) FILTER (WHERE status='WON' AND created_at >= NOW() - INTERVAL '7 days'), 0) AS maxp7,
        COALESCE(MAX(multiplier) FILTER (WHERE status='WON' AND created_at >= NOW() - INTERVAL '7 days'), 0) AS maxm7,
        COUNT(*) AS b30,
        COUNT(*) FILTER (WHERE status='WON') AS w30,
        COALESCE(SUM(bet_amount), 0) AS wag30,
        COALESCE(SUM(payout), 0) AS pay30,
        COALESCE(MAX(payout) FILTER (WHERE status='WON'), 0) AS maxp30,
        COALESCE(MAX(multiplier) FILTER (WHERE status='WON'), 0) AS maxm30
        FROM universal_bets WHERE status IN ('WON','LOST') AND created_at >= NOW() - INTERVAL '30 days' GROUP BY game_name`
      ).catch(() => ({ rows: [] })),
      pool.query(`SELECT game_name,
        COALESCE(SUM(total_bets) FILTER (WHERE COALESCE(period_end, created_at) >= NOW() - INTERVAL '1 day'), 0) AS b1,
        COALESCE(SUM(won_bets) FILTER (WHERE COALESCE(period_end, created_at) >= NOW() - INTERVAL '1 day'), 0) AS w1,
        COALESCE(SUM(total_wagered) FILTER (WHERE COALESCE(period_end, created_at) >= NOW() - INTERVAL '1 day'), 0) AS wag1,
        COALESCE(SUM(total_payout) FILTER (WHERE COALESCE(period_end, created_at) >= NOW() - INTERVAL '1 day'), 0) AS pay1,
        COALESCE(SUM(total_bets) FILTER (WHERE COALESCE(period_end, created_at) >= NOW() - INTERVAL '7 days'), 0) AS b7,
        COALESCE(SUM(won_bets) FILTER (WHERE COALESCE(period_end, created_at) >= NOW() - INTERVAL '7 days'), 0) AS w7,
        COALESCE(SUM(total_wagered) FILTER (WHERE COALESCE(period_end, created_at) >= NOW() - INTERVAL '7 days'), 0) AS wag7,
        COALESCE(SUM(total_payout) FILTER (WHERE COALESCE(period_end, created_at) >= NOW() - INTERVAL '7 days'), 0) AS pay7,
        COALESCE(SUM(total_bets), 0) AS b30,
        COALESCE(SUM(won_bets), 0) AS w30,
        COALESCE(SUM(total_wagered), 0) AS wag30,
        COALESCE(SUM(total_payout), 0) AS pay30
        FROM game_12h_reports WHERE COALESCE(period_end, created_at) >= NOW() - INTERVAL '30 days' GROUP BY game_name`
      ).catch(() => ({ rows: [] })),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') AS b1,
        COUNT(*) FILTER (WHERE status IN ('WON','CASHED_OUT') AND created_at >= NOW() - INTERVAL '1 day') AS w1,
        COALESCE(SUM(stake) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day'), 0) AS wag1,
        COALESCE(SUM(payout) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day'), 0) AS pay1,
        COALESCE(MAX(payout) FILTER (WHERE status IN ('WON','CASHED_OUT') AND created_at >= NOW() - INTERVAL '1 day'), 0) AS maxp1,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS b7,
        COUNT(*) FILTER (WHERE status IN ('WON','CASHED_OUT') AND created_at >= NOW() - INTERVAL '7 days') AS w7,
        COALESCE(SUM(stake) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0) AS wag7,
        COALESCE(SUM(payout) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0) AS pay7,
        COALESCE(MAX(payout) FILTER (WHERE status IN ('WON','CASHED_OUT') AND created_at >= NOW() - INTERVAL '7 days'), 0) AS maxp7,
        COUNT(*) AS b30,
        COUNT(*) FILTER (WHERE status IN ('WON','CASHED_OUT')) AS w30,
        COALESCE(SUM(stake), 0) AS wag30,
        COALESCE(SUM(payout), 0) AS pay30,
        COALESCE(MAX(payout) FILTER (WHERE status IN ('WON','CASHED_OUT')), 0) AS maxp30
        FROM sports_bets WHERE status IN ('WON','LOST','CASHED_OUT') AND created_at >= NOW() - INTERVAL '30 days'`
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT username,game_name,bet_amount,multiplier,payout,created_at FROM universal_bets WHERE status='WON' AND payout>0 AND created_at>=NOW()-INTERVAL '30 days' ORDER BY payout DESC,created_at DESC LIMIT 24`
      ).catch(() => ({ rows: [] }))
    ]);
    return {
      success: true,
      cachedAt: Date.now(),
      ttlSeconds: 60,
      periods: buildBestWinsPeriods({
        gameRows: gRes.rows,
        reportRows: rRes.rows,
        sportsSummary: sRes.rows[0] || null,
        topWinRows: wRes.rows,
        maskFn: mask
      })
    };
  });
  res.set('Cache-Control', 'public, max-age=30');
  res.json(payload);
}));

// ---------------------------------------------------------------- 1. user init (1 pooled SELECT fast-path for existing users; TX only on registration)
const initHandler = h(async (req, res) => {
  const { id, username, name } = req.tg;
  const existing = await pool.query('SELECT * FROM users WHERE user_id=$1', [id]);
  if (existing.rows.length) {
    return res.json(userView(existing.rows[0], false));
  }

  const refRaw = String(req.query.refId || req.body?.refId || '').trim().slice(0, 64);
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
  if (out.isNew) {
    vaultAdd({ bonus: CONFIG.WELCOME_BONUS });
    cacheInvalidate('admin:dashboard');
  }
  res.json(userView(out.u, out.isNew));
});
app.get('/api/user/init', userAuth, limit('init', 300, 60e3), initHandler);
app.post('/api/user/init', userAuth, limit('init', 300, 60e3), initHandler);

// Shared context passed into every game module, Sportsbook & Telegram Bot
const appCtx = {
  pool, io, CONFIG, Biz, h, tx, audit, lockUser, validWager,
  newId, mask, parseJson, vaultAdd, userAuth, admin, alog, notify, limit, flights, r2, num, parseInitData,
  cache, cacheInvalidate
};
const { shared: gameShared, settleAllStale } = mountAllGames(app, appCtx, __dirname);
const sportsbook = registerSportsbook(app, appCtx);
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
  if (!schemaReady) return;
  try {
    await expireDeposits();
    await settleAllStale();
    const r = await pool.query(`SELECT bet_id,user_id FROM universal_bets WHERE status='IN_FLIGHT' AND game_name=ANY($1) AND flight_start < NOW() - INTERVAL '5 minutes' LIMIT 100`, [CRASH_GAMES]);
    for (const b of r.rows) {
      try { const vd = await tx(async c => { const v = []; await gameShared.resolveCrash(c, b.bet_id, b.user_id, { vd: v }); return v; }); vd.forEach(vaultAdd); }
      catch (e) { console.error('sweep', e.message); }
    }
    for (const [k, f] of flights) if (Date.now() - f.start > 600e3) flights.delete(k);
  } catch (e) { console.error('sweeper:', e.message); }
}, 120e3).unref();

// Periodic 12-hour audit & purge every 30 minutes (guarantees no raw game/audit rows stay past 12h)
setInterval(() => {
  if (!schemaReady) return;
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
  cacheInvalidate('admin:dashboard');
  notifyAdmins(`NEW DEPOSIT ${id}\n${fmt(amt)} ETB via ${method}\nPlayer: @${req.tg.username || '-'} (${req.tg.id})${ref ? '\nRef: ' + ref : ''}`);
  res.json({ success: true, txnId: id, agent });
}));

app.post('/api/cashier/verify-deposit', userAuth, limit('verify', 12, 600e3), h(async (req, res) => {
  const method = PAY_METHODS.includes(req.body.method) ? req.body.method : 'Telebirr';
  const rawInput = String(req.body.ref || '').trim();
  const parsedInput = smsParsers.parseVerifyInput(rawInput, rawInput);
  const raw = parsedInput ? parsedInput.value : rawInput;
  const ref = raw.toUpperCase(), amt = r2(req.body.amount), uid = req.tg.id;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(raw)) throw new Biz('Enter the transaction reference or receipt link from your payment message');
  if (!(amt >= CONFIG.MIN_DEP && amt <= CONFIG.MAX_DEP)) throw new Biz(`Deposit must be between ${CONFIG.MIN_DEP} and ${CONFIG.MAX_DEP} ETB`);
  if (USE_EXTERNAL_VERIFI && !ENV.VERIFI_TOKEN) throw new Biz('Automatic verification is not available right now. Use "Send Deposit Request".', 503);
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
  if (!gatewayVerified(g.body)) {
    const st = String(g.body?.status || '');
    if (st === 'AlreadyUsed') {
      await release('Reference already claimed in SMS ledger');
      throw new Biz('This payment reference was already used.', 409);
    }
    if (st === 'InvalidAmount' && Number.isFinite(Number(g.body?.actual))) {
      const actual = Number(g.body.actual);
      await release(`Amount differs (${actual})`);
      throw new Biz(`The payment amount (${actual} ETB) does not match the amount you entered.`, 400);
    }
    if (st === 'Resolving') {
      await release('CBE receipt resolving');
      throw new Biz('CBE receipt is still resolving its FT number. Please wait 30 seconds and try again.', 404);
    }
    await release('Payment not found');
    throw new Biz('Payment not found yet. Check the reference and amount, wait a minute and try again.', 404);
  }
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
  cacheInvalidate('admin:dashboard');
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
  cacheInvalidate('admin:dashboard');
  res.json({ success: true, type: out.type, newBalance: out.newBal, message: out.type === 'WITHDRAWAL' ? 'Withdrawal cancelled and refunded' : 'Deposit request cancelled' });
}));

app.get('/api/cashier/history', userAuth, limit('hist', 180, 60e3), h(async (req, res) => {
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
  cacheInvalidate('admin:dashboard');
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
  const payload = await cache.getOrLoad('admin:dashboard', 3000, async () => {
    const q = (s, p) => pool.query(s, p);
    const [vault, cnt, pd, pw, rec, deps, wds, bets, promos, users, ggr, gs, gs12, spStats, retentionStats, reports12h, bonusM] = await Promise.all([
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
      q(`SELECT game_name,COALESCE(SUM(total_bets),0) bets,COALESCE(SUM(total_wagered),0) wagered,COALESCE(SUM(total_payout),0) paid FROM game_12h_reports GROUP BY game_name`).catch(() => ({ rows: [] })),
      q(`SELECT COUNT(*) bets,COALESCE(SUM(stake),0) wagered,COALESCE(SUM(payout),0) paid FROM sports_bets WHERE status IN ('WON','LOST','CASHED_OUT')`).catch(() => ({ rows: [{ bets: 0, wagered: 0, paid: 0 }] })),
      getRetentionStats(pool).catch(() => ({ activeBetsInDb: 0, activeAuditLogsInDb: 0, archived12hReports: 0, retentionWindowHours: 12 })),
      getReports12h(pool, 100).catch(() => []),
      q(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='BONUS' AND created_at>=date_trunc('month',NOW())`).catch(() => ({ rows: [{ s: 0 }] }))
    ]);
    const v = vault.rows[0] || {};
    const usersList = users.rows.map(userRow);

    const gameMap = new Map();
    const addGameStat = (name, b, w, p) => {
      const cur = gameMap.get(name) || { game: name, bets: 0, wagered: 0, paid: 0 };
      cur.bets += Number(b || 0);
      cur.wagered = r2(cur.wagered + num(w));
      cur.paid = r2(cur.paid + num(p));
      gameMap.set(name, cur);
    };
    gs.rows.forEach(g => addGameStat(g.game_name, g.bets, g.wagered, g.paid));
    gs12.rows.forEach(g => addGameStat(g.game_name, g.bets, g.wagered, g.paid));
    const sp = spStats.rows[0];
    if (sp && Number(sp.bets || 0) > 0) addGameStat('Sportsbook', sp.bets, sp.wagered, sp.paid);

    const targetFor = g => {
      if (g === 'KenoFast' || g === 'ClassicKeno') return r2(CONFIG.KENO_RTP * 100);
      if (g === 'Roulette') return 97.3;
      if (g === 'Sportsbook') return 92.0;
      return r2(CONFIG.TARGET_RTP * 100);
    };
    const gameStats = [...gameMap.values()].map(g => ({
      ...g,
      rtp: g.wagered ? r2((g.paid / g.wagered) * 100) : 0,
      targetRtp: targetFor(g.game)
    }));

    return {
      success: true,
      vault: { gross_profit: num(v.gross_profit), vault_balance: num(v.vault_balance), total_wagered: num(v.total_wagered), ggrToday: num(ggr.rows[0].d), ngrMonth: r2(num(ggr.rows[0].m) - num(bonusM.rows[0].s)), vaultBalance: num(v.vault_balance), totalWagered: num(v.total_wagered) },
      totalUsers: Number(cnt.rows[0].n), currentRtp: CONFIG.TARGET_RTP, currentCommission: CONFIG.AGENT_COMMISSION,
      pendingDeposits: pd.rows, pendingWithdrawals: pw.rows, completedHistory: rec.rows.filter(t => t.status !== 'PENDING'), recentTransactions: rec.rows,
      usersList, users: usersList, dep: deps.rows.map(fmtTx), wd: wds.rows.map(fmtTx),
      bets: bets.rows.map(b => ({ id: b.bet_id, u: b.username || b.user_id, m: b.game_name, p: num(b.multiplier) + 'x', s: num(b.bet_amount), st: String(b.status).toLowerCase() })),
      promos: promos.rows.map(p => ({ c: p.code, code: p.code, d: `+${p.bonus_amount} ETB (${p.times_used}/${p.max_uses})`, on: p.is_active ? 1 : 0 })),
      gameStats,
      retentionStats,
      reports12h,
      settings: {
        targetRtp: r2(CONFIG.TARGET_RTP * 100),
        kenoRtp: r2(CONFIG.KENO_RTP * 100),
        agentCommission: r2(CONFIG.AGENT_COMMISSION * 100),
        welcomeBonus: CONFIG.WELCOME_BONUS,
        referralBonus: CONFIG.REFERRAL_BONUS,
        cashbackPercent: CASHBACK.percent,
        cashbackMinLoss: CASHBACK.minLoss,
        minDep: CONFIG.MIN_DEP, maxDep: CONFIG.MAX_DEP, minWd: CONFIG.MIN_WTH, maxWd: CONFIG.MAX_WTH
      },
      system: {
        databaseConnected: HAS_DB,
        botConfigured: HAS_BOT_TOKEN,
        customAdminPin: Boolean(RAW_ADMIN_PIN.length >= 4),
        verifyMode: USE_EXTERNAL_VERIFI ? 'External Verify Server' : 'Built-in SMS Ledger',
        verifiUrl: USE_EXTERNAL_VERIFI ? VERIFI_URL : '(built-in /api/verify)',
        verifiTokenSet: USE_EXTERNAL_VERIFI ? Boolean(ENV.VERIFI_TOKEN) : true,
        autoDepMax: AUTO_DEP_MAX
      }
    };
  });
  res.json(payload);
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
  cacheInvalidate('admin:dashboard');
  res.json({
    ...out,
    message: `12h Audit complete: ${out.reportsCreated} summaries created, ${out.purgedBets} bets & ${out.purgedAuditLogs} audit logs pruned`
  });
}));

app.post('/api/admin/test-verify', admin, h(async (_req, res) => {
  if (!USE_EXTERNAL_VERIFI) {
    return res.json({ success: true, mode: 'local', message: 'Built-in SMS verification engine active on this server.' });
  }
  if (!ENV.VERIFI_TOKEN) {
    throw new Biz('VERIFI_TOKEN is not set in server environment variables.', 400);
  }
  try {
    const g = await verifyWithGateway('TESTPING0000', 100);
    const st = String(g.body?.status || 'Reachable');
    res.json({
      success: true,
      mode: 'external',
      url: VERIFI_URL,
      gatewayStatus: st,
      message: `Connected to verify server (${VERIFI_URL}) — status: ${st}`
    });
  } catch (e) {
    if (e instanceof Biz) throw e;
    throw new Biz(`Could not reach verify server (${VERIFI_URL}): ${e.message}`, 503);
  }
}));

app.post('/api/admin/sms-parse-test', admin, h(async (req, res) => {
  const message = String(req.body?.message || '');
  const sender = String(req.body?.sender || '');
  if (!message.trim()) throw new Biz('Paste a sample Telebirr or CBE SMS message to test');
  const c = smsParsers.classify(message, sender);
  const amount = smsParsers.extractAmount(c.msg);
  const balance = smsParsers.extractBalance(c.msg);
  const party = smsParsers.extractParty(c.msg, c.isIncoming, c.bank);
  const category = smsParsers.detectCategory(c.msg, c.isIncoming);
  const ft = c.isCbe ? smsParsers.extractDirectFt(c.msg) : null;
  const v2 = c.isCbe ? smsParsers.extractV2Code(c.msg) : null;
  const tbRef = !c.isCbe ? smsParsers.extractTelebirrRef(c.msg) : null;
  res.json({
    success: true,
    dryRun: true,
    bank: c.bank,
    txType: c.isIncoming ? 'Received' : (c.isOutgoing ? 'Transferred' : 'Ignored'),
    category,
    amount,
    balance,
    party,
    ref: ft || tbRef || null,
    v2Code: v2 || null,
    parsedInput: smsParsers.parseVerifyInput('', message)
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
  cacheInvalidate('admin:dashboard');
  alog(req, 'approve-deposit', `${txnId} ${out.amt} -> ${out.uid}`);
  notify(out.uid, `Your deposit of ${fmt(out.amt)} ETB was approved.`);
  res.json({ success: true, message: `Deposit ${txnId} approved (+${out.amt} ETB to ${out.uid})` });
}));
app.post('/api/admin/reject-deposit', admin, h(async (req, res) => {
  const reason = String(req.body.reason || 'Payment verification failed').slice(0, 200);
  const r = await pool.query(`UPDATE transactions SET status='REJECTED',remarks=$1,processed_by=$2,updated_at=NOW() WHERE txn_id=$3 AND type='DEPOSIT' AND status='PENDING' RETURNING user_id,amount`,
    [reason, req.actor, String(req.body.txnId || '')]);
  if (!r.rowCount) throw new Biz('Deposit already processed or not found');
  cacheInvalidate('admin:dashboard');
  alog(req, 'reject-deposit', req.body.txnId);
  notify(r.rows[0].user_id, `Your deposit of ${fmt(r.rows[0].amount)} ETB was rejected.\nReason: ${reason}`);
  res.json({ success: true, message: `Deposit ${req.body.txnId} rejected` });
}));
app.post('/api/admin/approve-withdrawal', admin, h(async (req, res) => {
  const r = await pool.query(`UPDATE transactions SET status='APPROVED',remarks=$1,processed_by=$2,updated_at=NOW() WHERE txn_id=$3 AND type='WITHDRAWAL' AND status='PENDING' RETURNING user_id,amount,method`,
    [`Payout completed by ${req.actor}`, req.actor, String(req.body.txnId || '')]);
  if (!r.rowCount) throw new Biz('Withdrawal already processed or not found');
  cacheInvalidate('admin:dashboard');
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
  cacheInvalidate('admin:dashboard');
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
  cacheInvalidate('admin:dashboard');
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
  cacheInvalidate('admin:dashboard');
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
  cacheInvalidate('admin:dashboard');
  alog(req, 'cashback', `${req.body.percentage}% -> ${out.n} players, ${out.total.toFixed(2)} ETB`);
  notifyCashback(out.items, req.body.percentage);
  res.json({ success: true, message: `Distributed ${out.total.toFixed(2)} ETB cashback to ${out.n} players (1x wagering applies)` });
}));

let cashbackFailedAt = 0;
let cashbackDoneDate = '';
async function cashbackTick() {
  if (!schemaReady || !CASHBACK.auto || Date.now() - cashbackFailedAt < 10 * 60e3) return;
  if (!cashbackDue(new Date(), cashbackDoneDate, CASHBACK.hour)) return;
  const last = (await pool.query(`SELECT value FROM system_settings WHERE key='cashback_last_run'`)).rows[0];
  const lastVal = last ? last.value : '';
  const key = cashbackDue(new Date(), lastVal, CASHBACK.hour);
  if (!key) { cashbackDoneDate = lastVal; return; }
  await pool.query(`INSERT INTO system_settings (key,value) VALUES ('cashback_last_run','') ON CONFLICT (key) DO NOTHING`);
  const claim = await pool.query(`UPDATE system_settings SET value=$1 WHERE key='cashback_last_run' AND value<>$1`, [key]);   // atomic: only one run per day
  if (claim.rowCount !== 1) { cashbackDoneDate = key; return; }
  try {
    const base = await pool.query(`INSERT INTO system_settings (key,value) VALUES ('cashback_baseline','done') ON CONFLICT (key) DO NOTHING RETURNING key`);
    if (base.rowCount === 1) {   // first ever run: today's starting line, so old losses are never paid retroactively
      await pool.query(`UPDATE users SET cashback_settled_loss=GREATEST(0,total_wagered-total_won)`);
      cashbackDoneDate = key;
      console.log('Auto cashback: starting line set, the first payout is tomorrow'); return;
    }
    const out = await runCashback(CASHBACK.percent / 100, CASHBACK.minLoss, 'AUTO', `${CASHBACK.percent}% daily cashback`);
    cashbackDoneDate = key;
    console.log(`Auto cashback ${key}: ${out.total.toFixed(2)} ETB to ${out.n} players`);
    notifyAdmins(`Daily cashback paid: ${fmt(out.total)} ETB to ${out.n} players (${CASHBACK.percent}%)`);
    notifyCashback(out.items, CASHBACK.percent);
  } catch (e) {
    cashbackFailedAt = Date.now(); console.error('auto cashback failed:', e.message);
    await pool.query(`UPDATE system_settings SET value='' WHERE key='cashback_last_run' AND value=$1`, [key]).catch(() => {});
  }
}
setInterval(() => cashbackTick().catch(e => console.error('cashback tick:', e.message)), 60e3).unref();

app.post('/api/admin/create-promo', admin, h(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 40), amt = r2(req.body.bonusAmount), max = parseInt(req.body.maxUses || 100, 10);
  if (!code || !(amt > 0 && amt <= 10000) || !(max > 0)) throw new Biz('Valid code, bonus amount and max uses required');
  await pool.query('INSERT INTO promo_codes (code,bonus_amount,max_uses) VALUES ($1,$2,$3)', [code, amt, max]);
  cacheInvalidate('admin:dashboard');
  alog(req, 'create-promo', `${code} +${amt} x${max}`);
  res.json({ success: true, message: `Promo ${code} created (+${amt} ETB)` });
}));
app.post('/api/admin/toggle-promo', admin, h(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 40);
  if (!code) throw new Biz('Promo code required');
  const r = await pool.query(`UPDATE promo_codes SET is_active=NOT is_active WHERE code=$1 RETURNING code,is_active`, [code]);
  if (!r.rowCount) throw new Biz('Promo code not found', 404);
  const on = Boolean(r.rows[0].is_active);
  cacheInvalidate('admin:dashboard');
  alog(req, 'toggle-promo', `${code} -> ${on ? 'active' : 'off'}`);
  res.json({ success: true, code, isActive: on, message: `Promo ${code} is now ${on ? 'active' : 'disabled'}` });
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
  cacheInvalidate('admin:dashboard');
  alog(req, 'reward-users', `${n} players x ${amt}`);
  res.json({ success: true, message: `Rewarded ${n} players with ${amt} ETB each (wager ${wr} ETB)` });
}));
app.post('/api/admin/update-settings', admin, h(async (req, res) => {
  const norm = v => { const x = parseFloat(v); return x > 1 ? x / 100 : x; };
  const saveKey = (k, val) => pool.query(`INSERT INTO system_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [k, String(val)]);
  const { targetRtp, agentCommission, kenoRtp, welcomeBonus, referralBonus, cashbackPercent } = req.body;
  if (kenoRtp !== undefined) {
    const v = norm(kenoRtp); if (!(v >= 0.5 && v <= 0.99)) throw new Biz('Keno RTP must be between 50% and 99%');
    CONFIG.KENO_RTP = v; await saveKey('keno_rtp', v);
  }
  if (targetRtp !== undefined) {
    const v = norm(targetRtp); if (!(v >= 0.5 && v <= 0.99)) throw new Biz('RTP must be between 50% and 99%');
    CONFIG.TARGET_RTP = v; await saveKey('target_rtp', v);
  }
  if (agentCommission !== undefined) {
    const v = norm(agentCommission); if (!(v >= 0 && v <= 0.2)) throw new Biz('Commission must be between 0% and 20%');
    CONFIG.AGENT_COMMISSION = v; await saveKey('agent_commission', v);
  }
  if (welcomeBonus !== undefined) {
    const v = r2(welcomeBonus); if (!Number.isFinite(v) || v < 0 || v > 500) throw new Biz('Welcome bonus must be 0 to 500 ETB');
    CONFIG.WELCOME_BONUS = v; await saveKey('welcome_bonus', v);
  }
  if (referralBonus !== undefined) {
    const v = r2(referralBonus); if (!Number.isFinite(v) || v < 0 || v > 1000) throw new Biz('Referral bonus must be 0 to 1000 ETB');
    CONFIG.REFERRAL_BONUS = v; await saveKey('referral_bonus', v);
  }
  if (cashbackPercent !== undefined) {
    const v = r2(cashbackPercent); if (!Number.isFinite(v) || v < 1 || v > 50) throw new Biz('Cashback % must be 1 to 50');
    CASHBACK.percent = v; await saveKey('cashback_percent', v);
  }
  cacheInvalidate('admin:dashboard');
  alog(req, 'update-settings', JSON.stringify({ targetRtp, kenoRtp, agentCommission, welcomeBonus, referralBonus, cashbackPercent }));
  res.json({ success: true, message: 'Settings saved & applied immediately' });
}));
app.post('/api/admin/user-status', admin, h(async (req, res) => {
  const status = String(req.body.status || '').toLowerCase();
  if (!['active', 'suspended', 'banned'].includes(status)) throw new Biz('Invalid status');
  const r = await pool.query('UPDATE users SET status=$1 WHERE user_id=$2', [status, String(req.body.userId)]);
  if (!r.rowCount) throw new Biz('User not found', 404);
  cacheInvalidate('admin:dashboard');
  alog(req, 'user-status', `${req.body.userId} -> ${status}`); res.json({ success: true, message: `User status changed to ${status}` });
}));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down, saving stats...');
  try { await flushVault(); } catch (_) {}
  try { await sportsbook.persistIfDirty(true); } catch (_) {}
  try { if (typeof pool.end === 'function') await pool.end(); } catch (_) {}
  try { server.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
const PORT = ENV.PORT || 3000;
ensureSchema()
  .then(closeLegacyRounds)
  .then(loadSettings)
  .then(refreshVaultCache)
  .then(hydrateChatBuffer)
  .then(() => sportsbook.restoreFixtures().then(() => sportsbook.startTick()).catch(() => sportsbook.startTick()))
  .then(() => gameShared.crashEngine.seedHistories().catch(() => {}))
  .then(() => runTwelveHourAuditAndPrune(pool).catch(e => console.warn('startup 12h audit:', e.message)))
  .finally(() => {
    schemaReady = true;
    smsVerifier.startCbeBackgroundResolver();
    server.listen(PORT, '0.0.0.0', () => console.log(`Hulu Bet server on 0.0.0.0:${PORT}`));
  });
