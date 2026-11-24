-- ============================================================================
-- HULU BET ULTRA — PRODUCTION LAUNCH & TEST CLEANUP SQL SCRIPT (PostgreSQL)
-- Run this in your SQL Editor (Neon / Render / Supabase / pgAdmin / psql)
-- Resets all test users, test bets, transactions & logs and initializes the
-- Casino Vault to 200,000.00 ETB for live production launch.
-- ============================================================================

BEGIN;

-- 1. Ensure core tables exist if running on a fresh database
CREATE TABLE IF NOT EXISTS casino_vault (
  id INTEGER PRIMARY KEY DEFAULT 1,
  vault_balance NUMERIC(14,2) DEFAULT 200000.00,
  total_wagered NUMERIC(14,2) DEFAULT 0.00,
  total_payouts NUMERIC(14,2) DEFAULT 0.00,
  gross_profit NUMERIC(14,2) DEFAULT 0.00,
  total_bonus_awarded NUMERIC(14,2) DEFAULT 0.00,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  user_id VARCHAR(64) PRIMARY KEY,
  telegram_username VARCHAR(128) DEFAULT '',
  full_name VARCHAR(128) DEFAULT 'Player',
  balance NUMERIC(14,2) DEFAULT 0.00,
  bonus_balance NUMERIC(14,2) DEFAULT 0.00,
  wager_requirement_left NUMERIC(14,2) DEFAULT 0.00,
  total_deposited NUMERIC(14,2) DEFAULT 0.00,
  total_wagered NUMERIC(14,2) DEFAULT 0.00,
  total_won NUMERIC(14,2) DEFAULT 0.00,
  first_deposit_completed VARCHAR(8) DEFAULT 'NO',
  referrer_id VARCHAR(64) DEFAULT '',
  referral_paid BOOLEAN DEFAULT FALSE,
  last_cashback_at TIMESTAMPTZ,
  last_spin_at TIMESTAMPTZ,
  cashback_settled_loss NUMERIC(14,2) DEFAULT 0.00,
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  role VARCHAR(24) DEFAULT 'player',
  status VARCHAR(24) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  txn_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  username VARCHAR(128) DEFAULT '',
  type VARCHAR(32) NOT NULL,
  method VARCHAR(32) DEFAULT '',
  amount NUMERIC(14,2) NOT NULL,
  net_amount NUMERIC(14,2) DEFAULT 0.00,
  bank_txn_id VARCHAR(64),
  sender_account VARCHAR(128) DEFAULT '',
  agent_assigned VARCHAR(64) DEFAULT '',
  status VARCHAR(32) DEFAULT 'PENDING',
  remarks TEXT DEFAULT '',
  processed_by VARCHAR(64) DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS universal_bets (
  bet_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  username VARCHAR(128) DEFAULT '',
  game_name VARCHAR(64) NOT NULL,
  bet_amount NUMERIC(14,2) NOT NULL,
  multiplier NUMERIC(10,4) DEFAULT 0,
  payout NUMERIC(14,2) DEFAULT 0.00,
  house_profit NUMERIC(14,2) DEFAULT 0.00,
  status VARCHAR(24) DEFAULT 'IN_FLIGHT',
  flight_start TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Wipe all test player accounts, bets, transactions, audit logs, and SMS test logs
TRUNCATE TABLE
  promo_redemptions,
  balance_audit_logs,
  universal_bets,
  sports_bets,
  transactions,
  game_12h_reports,
  chat_messages,
  admin_actions,
  cbe_transactions,
  telebirr_transactions,
  users
RESTART IDENTITY CASCADE;

-- Optional: uncomment the line below ONLY if you also want to remove test SMS agents
-- TRUNCATE TABLE sms_agents RESTART IDENTITY CASCADE;

-- 3. Restore Casino Vault to exactly 200,000.00 ETB (200k launch bankroll)
INSERT INTO casino_vault (id, vault_balance, total_wagered, total_payouts, gross_profit, total_bonus_awarded, updated_at)
VALUES (1, 200000.00, 0.00, 0.00, 0.00, 0.00, NOW())
ON CONFLICT (id) DO UPDATE SET
  vault_balance = 200000.00,
  total_wagered = 0.00,
  total_payouts = 0.00,
  gross_profit = 0.00,
  total_bonus_awarded = 0.00,
  updated_at = NOW();

-- 4. Reset Promo Code usage counters & clear cached virtual match state
UPDATE promo_codes SET times_used = 0;
INSERT INTO promo_codes (code, bonus_amount, max_uses, times_used, is_active)
VALUES ('HULU50', 50.00, 100, 0, TRUE)
ON CONFLICT (code) DO UPDATE SET times_used = 0, is_active = TRUE;

DELETE FROM system_settings WHERE key = 'sports_fixtures_state';

COMMIT;

-- 5. Verify Clean 200k Launch State
SELECT
  (SELECT vault_balance FROM casino_vault WHERE id = 1) AS vault_balance_etb,
  (SELECT COUNT(*) FROM users) AS total_users,
  (SELECT COUNT(*) FROM transactions) AS total_transactions,
  (SELECT COUNT(*) FROM universal_bets) AS total_casino_bets,
  (SELECT COUNT(*) FROM sports_bets) AS total_sports_bets;
