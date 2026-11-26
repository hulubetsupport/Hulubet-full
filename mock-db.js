'use strict';

function createMockPool() {
  const db = {
    users: new Map(),
    universal_bets: [],
    sports_bets: [],
    game_12h_reports: [],
    transactions: [],
    balance_audit_logs: [],
    admin_actions: [],
    chat_messages: [],
    system_settings: new Map(),
    promo_codes: new Map([
      ['HULU50', { code: 'HULU50', bonus_amount: 50, max_uses: 100, times_used: 0, is_active: true }]
    ]),
    promo_redemptions: [],
    agents: [
      { agent_id: 'Agent1hulubet', telegram_username: 'Agent1hulubet', total_deposits_processed: 0, total_commission_earned: 0 },
      { agent_id: 'Agent2hulubet', telegram_username: 'Agent2hulubet', total_deposits_processed: 0, total_commission_earned: 0 }
    ],
    casino_vault: {
      id: 1,
      vault_balance: 200000,
      total_wagered: 0,
      total_payouts: 0,
      gross_profit: 0,
      total_bonus_awarded: 0,
      updated_at: new Date()
    },
    sms_agents: [],
    cbe_transactions: [],
    telebirr_transactions: [],
    seq: 1
  };

  function dupErr(msg = 'duplicate key value violates unique constraint') {
    const e = new Error(msg);
    e.code = '23505';
    return e;
  }

  function exec(sqlRaw, params = []) {
    const sql = String(sqlRaw).replace(/\s+/g, ' ').trim();
    const low = sql.toLowerCase();

    if (/^(begin|commit|rollback|savepoint|release savepoint|rollback to savepoint|create |alter )/.test(low)) {
      return { rows: [], rowCount: 0 };
    }

    if (low.startsWith('truncate table')) {
      db.users.clear();
      db.universal_bets = [];
      db.sports_bets = [];
      db.game_12h_reports = [];
      db.transactions = [];
      db.balance_audit_logs = [];
      db.admin_actions = [];
      db.chat_messages = [];
      db.promo_redemptions = [];
      db.cbe_transactions = [];
      db.telebirr_transactions = [];
      db.seq = 1;
      for (const p of db.promo_codes.values()) p.times_used = 0;
      return { rows: [], rowCount: 1 };
    }

    // ---- casino_vault ----
    if (low.startsWith('insert into casino_vault') && low.includes('on conflict (id) do update')) {
      db.casino_vault.vault_balance = Number(params[0] ?? 200000);
      db.casino_vault.total_wagered = 0;
      db.casino_vault.total_payouts = 0;
      db.casino_vault.gross_profit = 0;
      db.casino_vault.total_bonus_awarded = 0;
      db.casino_vault.updated_at = new Date();
      return { rows: [db.casino_vault], rowCount: 1 };
    }
    if (low.startsWith('insert into casino_vault')) {
      return { rows: [db.casino_vault], rowCount: 1 };
    }
    if (low.startsWith('select vault_balance from casino_vault')) {
      return { rows: [{ vault_balance: db.casino_vault.vault_balance }], rowCount: 1 };
    }
    if (low.startsWith('select * from casino_vault')) {
      return { rows: [{ ...db.casino_vault }], rowCount: 1 };
    }
    if (low.startsWith('update casino_vault set vault_balance=$1,total_wagered=0')) {
      db.casino_vault.vault_balance = Number(params[0] ?? 200000);
      db.casino_vault.total_wagered = 0;
      db.casino_vault.total_payouts = 0;
      db.casino_vault.gross_profit = 0;
      db.casino_vault.total_bonus_awarded = 0;
      db.casino_vault.updated_at = new Date();
      return { rows: [{ vault_balance: db.casino_vault.vault_balance }], rowCount: 1 };
    }
    if (low.startsWith('update casino_vault set vault_balance=')) {
      db.casino_vault.vault_balance += Number(params[0] || 0);
      db.casino_vault.total_wagered += Number(params[1] || 0);
      db.casino_vault.total_payouts += Number(params[2] || 0);
      db.casino_vault.gross_profit += Number(params[3] || 0);
      db.casino_vault.total_bonus_awarded += Number(params[4] || 0);
      db.casino_vault.updated_at = new Date();
      return { rows: low.includes('returning') ? [{ vault_balance: db.casino_vault.vault_balance }] : [], rowCount: 1 };
    }
    if (low.startsWith('update casino_vault set total_bonus_awarded=')) {
      db.casino_vault.total_bonus_awarded += Number(params[0] || 0);
      return { rows: [], rowCount: 1 };
    }

    // ---- system_settings ----
    if (low.startsWith('select key,value from system_settings')) {
      return { rows: [...db.system_settings.entries()].map(([key, value]) => ({ key, value })), rowCount: db.system_settings.size };
    }
    if (low.startsWith('select value from system_settings where key=')) {
      const m = sql.match(/key='([^']+)'/i);
      const k = m ? m[1] : params[0];
      const v = db.system_settings.get(k);
      return v !== undefined ? { rows: [{ value: v }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('insert into system_settings')) {
      const m = sql.match(/values\s*\(\s*'([^']+)'\s*,\s*(?:'([^']*)'|\$1)\s*\)/i);
      const k = m ? m[1] : params[0];
      const v = m ? (m[2] !== undefined ? m[2] : params[0]) : params[1];
      if (low.includes('do nothing')) {
        if (db.system_settings.has(k)) return { rows: [], rowCount: 0 };
        db.system_settings.set(k, v);
        return { rows: [{ key: k, value: v }], rowCount: 1 };
      }
      db.system_settings.set(k, v);
      return { rows: [{ key: k, value: v }], rowCount: 1 };
    }
    if (low.startsWith('update system_settings set value=')) {
      const m = sql.match(/key='([^']+)'/i);
      const k = m ? m[1] : params[1];
      const v = low.includes("value=''") ? '' : params[0];
      const cur = db.system_settings.get(k);
      if (low.includes('value<>$1') && cur === params[0]) return { rows: [], rowCount: 0 };
      if (low.includes('and value=$1') && cur !== params[0]) return { rows: [], rowCount: 0 };
      db.system_settings.set(k, v);
      return { rows: [], rowCount: 1 };
    }

    // ---- agents ----
    if (low.startsWith('select telegram_username from agents')) {
      return { rows: db.agents.map(a => ({ telegram_username: a.telegram_username })), rowCount: db.agents.length };
    }
    if (low.startsWith('update agents set')) {
      const a = db.agents.find(x => x.telegram_username.toLowerCase() === String(params[2] || '').toLowerCase() || x.agent_id === params[2]);
      if (a) {
        a.total_deposits_processed += Number(params[0] || 0);
        a.total_commission_earned += Number(params[1] || 0);
      }
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    // ---- users ----
    if (low.startsWith('select 1 from users where user_id=$1')) {
      const u = db.users.get(String(params[0]));
      return u ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('insert into users')) {
      const [uid, uname, fname, bal, wr, ref] = params;
      const id = String(uid);
      if (db.users.has(id)) return { rows: [], rowCount: 0 };
      const u = {
        user_id: id,
        telegram_username: uname || 'player',
        full_name: fname || 'Player',
        balance: Number(bal),
        bonus_balance: Number(bal),
        wager_requirement_left: Number(wr || 0),
        total_deposited: 0,
        total_wagered: 0,
        total_won: 0,
        first_deposit_completed: 'NO',
        referrer_id: ref || '',
        referral_paid: false,
        last_cashback_at: null,
        last_spin_at: null,
        cashback_settled_loss: 0,
        last_active_at: new Date(),
        role: 'player',
        status: 'active'
      };
      db.users.set(id, u);
      return { rows: [{ ...u }], rowCount: 1 };
    }
    if (low.startsWith('select count(*) n from users where referrer_id=$1')) {
      const refId = String(params[0]);
      const n = [...db.users.values()].filter(u => u.referrer_id === refId).length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    if (low.startsWith('select count(*) n from users')) {
      return { rows: [{ n: String(db.users.size) }], rowCount: 1 };
    }
    if (low.startsWith('select u.*,(select count(*) from universal_bets')) {
      let list = [...db.users.values()];
      if (params.length === 3 && params[0]) {
        const q = String(params[0]).toLowerCase();
        list = list.filter(u =>
          u.user_id.toLowerCase().includes(q) ||
          (u.telegram_username || '').toLowerCase().includes(q) ||
          (u.full_name || '').toLowerCase().includes(q)
        );
      }
      list.sort((a, b) => b.balance - a.balance);
      const offset = params.length === 3 ? Number(params[2] || 0) : 0;
      const rows = list.slice(offset, offset + 100).map(u => ({
        ...u,
        bet_count: db.universal_bets.filter(b => b.user_id === u.user_id).length
      }));
      return { rows, rowCount: rows.length };
    }
    if (low.includes('from users where (total_wagered-total_won')) {
      const cutoff = Number(params[0] || 0);
      const rows = [...db.users.values()]
        .filter(u => String(u.status).toLowerCase() === 'active' && (u.total_wagered - u.total_won - (u.cashback_settled_loss || 0)) >= cutoff)
        .map(u => ({ user_id: u.user_id, balance: u.balance, net_loss: u.total_wagered - u.total_won, settled: u.cashback_settled_loss || 0 }));
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select user_id,balance from users where user_id=any($1')) {
      const ids = new Set((params[0] || []).map(String));
      const rows = [...db.users.values()].filter(u => ids.has(u.user_id)).map(u => ({ user_id: u.user_id, balance: u.balance }));
      return { rows, rowCount: rows.length };
    }
    if (low.includes('from users where user_id=$1')) {
      const u = db.users.get(String(params[0]));
      if (!u) return { rows: [], rowCount: 0 };
      const refCount = low.includes('as referral_count') ? [...db.users.values()].filter(x => x.referrer_id === u.user_id).length : undefined;
      return { rows: [{ ...u, ...(refCount !== undefined ? { referral_count: refCount } : {}) }], rowCount: 1 };
    }
    if (low.startsWith('update users set balance=$1,total_wagered=total_wagered+$2,total_won=total_won+$3')) {
      const u = db.users.get(String(params[3]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance = Number(params[0]);
      u.total_wagered += Number(params[1]);
      u.total_won += Number(params[2]);
      u.wager_requirement_left = Math.max(0, (u.wager_requirement_left || 0) - Number(params[1]));
      if (u.wager_requirement_left === 0) u.bonus_balance = 0;
      u.last_active_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set balance=$1,total_wagered=total_wagered+$2')) {
      const u = db.users.get(String(params[2]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance = Number(params[0]);
      u.total_wagered += Number(params[1]);
      u.wager_requirement_left = Math.max(0, (u.wager_requirement_left || 0) - Number(params[1]));
      if (u.wager_requirement_left === 0) u.bonus_balance = 0;
      u.last_active_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set balance=$1,total_won=total_won+$2')) {
      const u = db.users.get(String(params[2]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance = Number(params[0]);
      u.total_won += Number(params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set balance=balance+$1,total_wagered=greatest')) {
      const u = db.users.get(String(params[1]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance += Number(params[0]);
      u.total_wagered = Math.max(0, u.total_wagered - Number(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith("update users set balance=$1,total_deposited=total_deposited+$2,first_deposit_completed='yes',bonus_balance=bonus_balance+$3,wager_requirement_left=wager_requirement_left+$4")) {
      const u = db.users.get(String(params[4]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance = Number(params[0]);
      u.total_deposited += Number(params[1]);
      u.first_deposit_completed = 'YES';
      u.bonus_balance = (u.bonus_balance || 0) + Number(params[2] || 0);
      u.wager_requirement_left = (u.wager_requirement_left || 0) + Number(params[3] || 0);
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith("update users set balance=$1,total_deposited=total_deposited+$2,first_deposit_completed='yes'")) {
      const u = db.users.get(String(params[2]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance = Number(params[0]);
      u.total_deposited += Number(params[1]);
      u.first_deposit_completed = 'YES';
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set balance=$1,bonus_balance=bonus_balance+$2,wager_requirement_left=wager_requirement_left+$3,cashback_settled_loss=$4')) {
      const u = db.users.get(String(params[4]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance = Number(params[0]);
      u.bonus_balance += Number(params[1]);
      u.wager_requirement_left += Number(params[2]);
      u.cashback_settled_loss = Number(params[3]);
      u.last_cashback_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set balance=$1,bonus_balance=bonus_balance+$2,wager_requirement_left=wager_requirement_left+$2,cashback_settled_loss=$3')) {
      const u = db.users.get(String(params[3]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance = Number(params[0]);
      u.bonus_balance += Number(params[1]);
      u.wager_requirement_left += Number(params[1]);
      u.cashback_settled_loss = Number(params[2]);
      u.last_cashback_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set balance=$1,bonus_balance=bonus_balance+$2,wager_requirement_left=wager_requirement_left+$3')) {
      const u = db.users.get(String(params[3]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance = Number(params[0]);
      u.bonus_balance += Number(params[1]);
      u.wager_requirement_left += Number(params[2]);
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set balance=balance+$1,bonus_balance=bonus_balance+$1,wager_requirement_left=wager_requirement_left+$2')) {
      const u = db.users.get(String(params[2]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance += Number(params[0]);
      u.bonus_balance += Number(params[0]);
      u.wager_requirement_left += Number(params[1]);
      return { rows: [{ balance: u.balance }], rowCount: 1 };
    }
    if (low.startsWith('update users set last_spin_at=now(),balance=$1,bonus_balance=bonus_balance+$2,wager_requirement_left=wager_requirement_left+$3')) {
      const u = db.users.get(String(params[3]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance = Number(params[0]);
      u.bonus_balance += Number(params[1]);
      u.wager_requirement_left += Number(params[2]);
      u.last_spin_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set last_spin_at=now() where user_id=$1')) {
      const u = db.users.get(String(params[0]));
      if (!u) return { rows: [], rowCount: 0 };
      u.last_spin_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set balance=$1 where user_id=$2')) {
      const u = db.users.get(String(params[1]));
      if (!u) return { rows: [], rowCount: 0 };
      u.balance = Number(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set referral_paid=true')) {
      const u = db.users.get(String(params[0]));
      if (u) u.referral_paid = true;
      return { rows: [], rowCount: u ? 1 : 0 };
    }
    if (low.startsWith('update users set status=$1')) {
      const u = db.users.get(String(params[1]));
      if (!u) return { rows: [], rowCount: 0 };
      u.status = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update users set cashback_settled_loss=')) {
      db.users.forEach(u => { u.cashback_settled_loss = Math.max(0, u.total_wagered - u.total_won); });
      return { rows: [], rowCount: db.users.size };
    }

    // ---- universal_bets ----
    if (low.startsWith('insert into universal_bets')) {
      const isInFlight = low.includes("'in_flight'");
      if (isInFlight) {
        let bet_id, game_name, user_id, username, bet_amount, tier_applied, game_data, flight_start;
        if (params.length >= 8) {
          [bet_id, game_name, user_id, username, bet_amount, tier_applied, game_data, flight_start] = params;
        } else {
          [bet_id, game_name, user_id, username, bet_amount, game_data, flight_start] = params;
          tier_applied = game_name === 'ChickenRoad2' ? 'Chicken' : 'Crash';
        }
        db.universal_bets.unshift({
          bet_id, game_name, user_id: String(user_id), username, bet_amount: Number(bet_amount),
          rng_roll: 0, tier_applied,
          multiplier: 0, payout: 0, house_profit: 0, status: 'IN_FLIGHT',
          game_data, flight_start: flight_start || new Date(), created_at: new Date()
        });
      } else {
        const [bet_id, game_name, user_id, username, bet_amount, rng_roll, tier_applied, multiplier, payout, house_profit, status, game_data] = params;
        db.universal_bets.unshift({
          bet_id, game_name, user_id: String(user_id), username, bet_amount: Number(bet_amount),
          rng_roll, tier_applied, multiplier: Number(multiplier), payout: Number(payout),
          house_profit: Number(house_profit), status, game_data, flight_start: null, created_at: new Date()
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (low === 'select count(*) n from universal_bets') {
      return { rows: [{ n: String(db.universal_bets.length) }], rowCount: 1 };
    }
    if (low.startsWith('select count(*) n from universal_bets where user_id=$1')) {
      const uid = String(params[0]);
      const cutoff = Date.now() - 6 * 60 * 1000;
      const n = db.universal_bets.filter(b => b.user_id === uid && b.status === 'IN_FLIGHT' && (!b.flight_start || new Date(b.flight_start).getTime() > cutoff)).length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    if (low.startsWith('select 1 from universal_bets where user_id=$1 and game_name=$2')) {
      const [uid, g] = params;
      const cutoff = Date.now() - 10 * 60 * 1000;
      const found = db.universal_bets.some(b => b.user_id === String(uid) && b.game_name === g && b.status === 'IN_FLIGHT' && (!b.flight_start || new Date(b.flight_start).getTime() > cutoff));
      return found ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('select 1 from universal_bets where user_id=$1 and status=\'in_flight\'')) {
      const uid = String(params[0]);
      const cutoff = Date.now() - 6 * 60 * 1000;
      const found = db.universal_bets.some(b => b.user_id === uid && b.status === 'IN_FLIGHT' && (!b.flight_start || new Date(b.flight_start).getTime() > cutoff));
      return found ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('select bet_id,bet_amount,game_data from universal_bets')) {
      const [uid, g] = params;
      const cutoff = Date.now() - 10 * 60 * 1000;
      const b = db.universal_bets.find(x => x.user_id === String(uid) && x.game_name === g && x.status === 'IN_FLIGHT' && (!x.flight_start || new Date(x.flight_start).getTime() > cutoff));
      return b ? { rows: [{ bet_id: b.bet_id, bet_amount: b.bet_amount, game_data: b.game_data }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('select game_data from universal_bets where bet_id=$1')) {
      const [betId, uid, games] = params;
      const b = db.universal_bets.find(x => x.bet_id === betId && x.user_id === String(uid) && games.includes(x.game_name));
      return b ? { rows: [{ game_data: b.game_data }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('select bet_id from universal_bets where user_id=$1')) {
      const [uid, roundId, games] = params;
      const rows = db.universal_bets.filter(x => {
        if (x.user_id !== String(uid) || !games.includes(x.game_name)) return false;
        try { return JSON.parse(x.game_data).roundId === roundId; } catch { return false; }
      }).map(x => ({ bet_id: x.bet_id }));
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("select 1 from universal_bets where status='in_flight'")) {
      const [betId, uid, roundId, games] = params;
      const found = db.universal_bets.some(x => {
        if (x.status !== 'IN_FLIGHT' || x.bet_id === betId || x.user_id !== String(uid) || !games.includes(x.game_name)) return false;
        try { return JSON.parse(x.game_data).roundId === roundId; } catch { return false; }
      });
      return found ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith("select bet_id from universal_bets where status='in_flight'")) {
      const [betId, uid, roundId, games] = params;
      const rows = db.universal_bets.filter(x => {
        if (x.status !== 'IN_FLIGHT' || x.bet_id === betId || x.user_id !== String(uid) || !games.includes(x.game_name)) return false;
        try { return JSON.parse(x.game_data).roundId === roundId; } catch { return false; }
      }).map(x => ({ bet_id: x.bet_id }));
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select * from universal_bets where bet_id=$1')) {
      const [betId, uid, third] = params;
      const b = db.universal_bets.find(x => x.bet_id === betId && x.user_id === String(uid) && (Array.isArray(third) ? third.includes(x.game_name) : x.game_name === third));
      return b ? { rows: [{ ...b }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('select bet_id,user_id from universal_bets')) {
      if (low.includes('where game_name=$1')) {
        const cutoff = Date.now() - 10 * 60 * 1000;
        const rows = db.universal_bets
          .filter(x => x.game_name === params[0] && x.status === 'IN_FLIGHT' && x.flight_start && new Date(x.flight_start).getTime() < cutoff)
          .slice(0, 100)
          .map(x => ({ bet_id: x.bet_id, user_id: x.user_id }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }
    if (low.startsWith('update universal_bets set status=$1,multiplier=$2,payout=$3,house_profit=$4 where bet_id=$5')) {
      const b = db.universal_bets.find(x => x.bet_id === params[4]);
      if (b) { b.status = params[0]; b.multiplier = Number(params[1]); b.payout = Number(params[2]); b.house_profit = Number(params[3]); }
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    if (low.startsWith("update universal_bets set status='lost',multiplier=0,payout=0,house_profit=$1,game_data=$2 where bet_id=$3")) {
      const b = db.universal_bets.find(x => x.bet_id === params[2]);
      if (b) { b.status = 'LOST'; b.multiplier = 0; b.payout = 0; b.house_profit = Number(params[0]); b.game_data = params[1]; }
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    if (low.startsWith("update universal_bets set status='won',multiplier=$1,payout=$2,house_profit=$3,game_data=$4 where bet_id=$5")) {
      const b = db.universal_bets.find(x => x.bet_id === params[4]);
      if (b) { b.status = 'WON'; b.multiplier = Number(params[0]); b.payout = Number(params[1]); b.house_profit = Number(params[2]); b.game_data = params[3]; }
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    if (low.startsWith("update universal_bets set status='won',multiplier=$1,payout=$2,house_profit=$3 where bet_id=$4")) {
      const b = db.universal_bets.find(x => x.bet_id === params[3]);
      if (b) { b.status = 'WON'; b.multiplier = Number(params[0]); b.payout = Number(params[1]); b.house_profit = Number(params[2]); }
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    if (low.startsWith('update universal_bets set game_data=$1 where bet_id=$2')) {
      const b = db.universal_bets.find(x => x.bet_id === params[1]);
      if (b) b.game_data = params[0];
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    if (low.startsWith("update universal_bets set status='void'")) {
      const b = db.universal_bets.find(x => x.bet_id === params[1]);
      if (b) { b.status = 'VOID'; b.multiplier = 0; b.payout = Number(params[0]); b.house_profit = 0; }
      return { rows: [], rowCount: b ? 1 : 0 };
    }
    if (low.startsWith("update universal_bets set status='lost',multiplier=0,payout=0,house_profit=bet_amount where bet_id=any($1")) {
      const ids = new Set(params[0] || []);
      let n = 0;
      db.universal_bets.forEach(b => {
        if (ids.has(b.bet_id) && b.status === 'IN_FLIGHT') {
          b.status = 'LOST'; b.multiplier = 0; b.payout = 0; b.house_profit = b.bet_amount; n++;
        }
      });
      return { rows: [], rowCount: n };
    }
    if (low.startsWith("update universal_bets set status='lost',house_profit=bet_amount where status='in_flight'")) {
      let n = 0;
      db.universal_bets.forEach(b => { if (b.status === 'IN_FLIGHT' && !b.flight_start) { b.status = 'LOST'; b.house_profit = b.bet_amount; n++; } });
      return { rows: [], rowCount: n };
    }
    if (low.startsWith("select username,game_name,bet_amount,multiplier,payout,created_at from universal_bets")) {
      const cutoff = Date.now() - 30 * 86400e3;
      const rows = db.universal_bets
        .filter(b => b.status === 'WON' && b.payout > 0 && new Date(b.created_at).getTime() >= cutoff)
        .sort((a, b) => b.payout - a.payout || new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 24);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("select username,game_name,payout,multiplier from universal_bets")) {
      const rows = db.universal_bets.filter(b => b.status === 'WON' && b.payout >= 100).slice(0, 15);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("select game_data") && low.includes("from universal_bets where game_name=$1")) {
      const lim = Number(params[1] || 30);
      const rows = db.universal_bets.filter(b => b.game_name === params[0] && ['WON', 'LOST'].includes(b.status)).slice(0, lim);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("select bet_id,game_name,bet_amount,multiplier,payout,status") && low.includes("from universal_bets where user_id=$1")) {
      const cutoff = params[1] ? new Date(params[1]).getTime() : 0;
      const rows = db.universal_bets
        .filter(b => b.user_id === String(params[0]) && b.status !== 'IN_FLIGHT' && new Date(b.created_at).getTime() >= cutoff)
        .slice(0, 60);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("select * from universal_bets where status<>'in_flight'")) {
      const rows = db.universal_bets.filter(b => b.status !== 'IN_FLIGHT').slice(0, 50);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select coalesce(sum(house_profit)')) {
      const now = new Date();
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const monStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      let d = 0, m = 0;
      for (const b of db.universal_bets) {
        if (!['WON', 'LOST'].includes(b.status)) continue;
        const t = new Date(b.created_at).getTime();
        if (t >= dayStart) d += b.house_profit;
        if (t >= monStart) m += b.house_profit;
      }
      return { rows: [{ d, m }], rowCount: 1 };
    }
    if (low.startsWith('select game_name,count(*) bets')) {
      const map = new Map();
      for (const b of db.universal_bets) {
        if (!['WON', 'LOST'].includes(b.status)) continue;
        const cur = map.get(b.game_name) || { game_name: b.game_name, bets: 0, wagered: 0, paid: 0 };
        cur.bets++; cur.wagered += b.bet_amount; cur.paid += b.payout;
        map.set(b.game_name, cur);
      }
      const rows = [...map.values()];
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select game_name, count(*) filter')) {
      const now = Date.now();
      const c1 = now - 86400e3;
      const c7 = now - 7 * 86400e3;
      const c30 = now - 30 * 86400e3;
      const map = new Map();
      for (const b of db.universal_bets) {
        if (!['WON', 'LOST'].includes(b.status)) continue;
        const ts = new Date(b.created_at).getTime();
        if (ts < c30) continue;
        const cur = map.get(b.game_name) || {
          game_name: b.game_name,
          b1: 0, w1: 0, wag1: 0, pay1: 0, maxp1: 0, maxm1: 0,
          b7: 0, w7: 0, wag7: 0, pay7: 0, maxp7: 0, maxm7: 0,
          b30: 0, w30: 0, wag30: 0, pay30: 0, maxp30: 0, maxm30: 0
        };
        const isWon = b.status === 'WON';
        const addWin = s => {
          cur['b' + s]++; cur['wag' + s] += b.bet_amount; cur['pay' + s] += b.payout;
          if (isWon) {
            cur['w' + s]++;
            if (b.payout > cur['maxp' + s]) cur['maxp' + s] = b.payout;
            if (b.multiplier > cur['maxm' + s]) cur['maxm' + s] = b.multiplier;
          }
        };
        addWin('30');
        if (ts >= c7) addWin('7');
        if (ts >= c1) addWin('1');
        map.set(b.game_name, cur);
      }
      const rows = [...map.values()];
      return { rows, rowCount: rows.length };
    }

    // ---- 12h audit & pruning queries ----
    if (low.startsWith('select exists(select 1 from universal_bets')) {
      const cutoff = new Date(params[0]).getTime();
      const has_bets = db.universal_bets.some(b => new Date(b.created_at).getTime() < cutoff);
      const has_audits = db.balance_audit_logs.some(l => new Date(l.created_at).getTime() < cutoff);
      const has_sports = db.sports_bets.some(s => new Date(s.created_at).getTime() < cutoff);
      return { rows: [{ has_bets, has_audits, has_sports }], rowCount: 1 };
    }
    if (low.startsWith("update universal_bets set status='lost', house_profit=bet_amount where status='in_flight' and created_at < $1") ||
        low.startsWith("update universal_bets set status='lost',house_profit=bet_amount where status='in_flight' and created_at < $1")) {
      const cutoff = new Date(params[0]).getTime();
      let n = 0;
      db.universal_bets.forEach(b => {
        if (b.status === 'IN_FLIGHT' && new Date(b.created_at).getTime() < cutoff) {
          b.status = 'LOST';
          b.house_profit = b.bet_amount;
          n++;
        }
      });
      return { rows: [], rowCount: n };
    }
    if (low.startsWith("select bet_id, game_name, user_id, bet_amount, payout, status, created_at from universal_bets where status in ('won', 'lost', 'void') and created_at < $1")) {
      const cutoff = new Date(params[0]).getTime();
      const rows = db.universal_bets.filter(b => ['WON', 'LOST', 'VOID'].includes(b.status) && new Date(b.created_at).getTime() < cutoff);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("delete from universal_bets where status in ('won', 'lost', 'void') and created_at < $1")) {
      const cutoff = new Date(params[0]).getTime();
      const before = db.universal_bets.length;
      db.universal_bets = db.universal_bets.filter(b => !(['WON', 'LOST', 'VOID'].includes(b.status) && new Date(b.created_at).getTime() < cutoff));
      return { rows: [], rowCount: before - db.universal_bets.length };
    }
    if (low.startsWith('delete from balance_audit_logs where created_at < $1')) {
      const cutoff = new Date(params[0]).getTime();
      const before = db.balance_audit_logs.length;
      db.balance_audit_logs = db.balance_audit_logs.filter(l => !(new Date(l.created_at).getTime() < cutoff));
      return { rows: [], rowCount: before - db.balance_audit_logs.length };
    }
    if (low === 'select count(*) n from balance_audit_logs') {
      return { rows: [{ n: String(db.balance_audit_logs.length) }], rowCount: 1 };
    }
    if (low === 'select count(*) n from game_12h_reports') {
      return { rows: [{ n: String(db.game_12h_reports.length) }], rowCount: 1 };
    }
    if (low.startsWith('insert into game_12h_reports')) {
      const [period_start, period_end, game_name, total_bets, won_bets, lost_bets, total_wagered, total_payout, net_profit, actual_rtp, unique_players, audit_entries_purged] = params;
      db.game_12h_reports.unshift({
        id: db.seq++,
        period_start, period_end, game_name,
        total_bets: Number(total_bets), won_bets: Number(won_bets), lost_bets: Number(lost_bets),
        total_wagered: Number(total_wagered), total_payout: Number(total_payout), net_profit: Number(net_profit),
        actual_rtp: Number(actual_rtp), unique_players: Number(unique_players), audit_entries_purged: Number(audit_entries_purged || 0),
        created_at: new Date()
      });
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('select * from game_12h_reports order by created_at desc')) {
      const lim = Number(params[0] || 100);
      const rows = db.game_12h_reports.slice(0, lim);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select game_name, coalesce(sum(total_bets) filter')) {
      const now = Date.now();
      const c1 = now - 86400e3;
      const c7 = now - 7 * 86400e3;
      const c30 = now - 30 * 86400e3;
      const map = new Map();
      for (const r of db.game_12h_reports) {
        const ts = new Date(r.period_end || r.created_at).getTime();
        if (ts < c30) continue;
        const cur = map.get(r.game_name) || {
          game_name: r.game_name,
          b1: 0, w1: 0, wag1: 0, pay1: 0,
          b7: 0, w7: 0, wag7: 0, pay7: 0,
          b30: 0, w30: 0, wag30: 0, pay30: 0
        };
        const addWin = s => {
          cur['b' + s] += Number(r.total_bets || 0);
          cur['w' + s] += Number(r.won_bets || 0);
          cur['wag' + s] += Number(r.total_wagered || 0);
          cur['pay' + s] += Number(r.total_payout || 0);
        };
        addWin('30');
        if (ts >= c7) addWin('7');
        if (ts >= c1) addWin('1');
        map.set(r.game_name, cur);
      }
      const rows = [...map.values()];
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select game_name,coalesce(sum(total_bets),0)')) {
      const map = new Map();
      for (const r of db.game_12h_reports) {
        const cur = map.get(r.game_name) || { game_name: r.game_name, bets: 0, wagered: 0, paid: 0 };
        cur.bets += Number(r.total_bets || 0);
        cur.wagered += Number(r.total_wagered || 0);
        cur.paid += Number(r.total_payout || 0);
        map.set(r.game_name, cur);
      }
      const rows = [...map.values()];
      return { rows, rowCount: rows.length };
    }

    // ---- sports_bets ----
    if (low.startsWith('insert into sports_bets')) {
      const [ticket_id, user_id, username, match_id, match_title, market, odds, stake, potential_win, cashout_value, status] = params;
      const row = {
        ticket_id,
        user_id: String(user_id),
        username,
        match_id,
        match_title,
        market,
        odds: Number(odds),
        stake: Number(stake),
        potential_win: Number(potential_win),
        cashout_value: Number(cashout_value),
        payout: 0,
        status: status || 'IN_PLAY',
        created_at: new Date(),
        settled_at: null
      };
      db.sports_bets.unshift(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (low.startsWith('select coalesce(ticket_id,bet_id) as bet_id,match_title,market,odds,stake,payout,status,created_at from sports_bets where user_id=$1')) {
      const cutoff = params[1] ? new Date(params[1]).getTime() : 0;
      const rows = db.sports_bets
        .filter(s => s.user_id === String(params[0]) && s.status !== 'IN_PLAY' && new Date(s.created_at).getTime() >= cutoff)
        .slice(0, 30)
        .map(s => ({ bet_id: s.ticket_id || s.bet_id, match_title: s.match_title, market: s.market, odds: s.odds, stake: s.stake, payout: s.payout, status: s.status, created_at: s.created_at }));
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select * from sports_bets where user_id=$1')) {
      const rows = db.sports_bets.filter(s => s.user_id === String(params[0])).slice(0, 40);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("select * from sports_bets where match_id=$1 and status='in_play'")) {
      const rows = db.sports_bets.filter(s => s.match_id === params[0] && s.status === 'IN_PLAY');
      return { rows: rows.map(r => ({ ...r })), rowCount: rows.length };
    }
    if (low.startsWith("select match_id,stake,potential_win from sports_bets where status='in_play'")) {
      const rows = db.sports_bets.filter(s => s.status === 'IN_PLAY').map(s => ({ match_id: s.match_id, stake: s.stake, potential_win: s.potential_win }));
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("select count(*) filter")) {
      const now = Date.now();
      const c1 = now - 86400e3;
      const c7 = now - 7 * 86400e3;
      const c30 = now - 30 * 86400e3;
      const acc = { b1: 0, w1: 0, wag1: 0, pay1: 0, maxp1: 0, b7: 0, w7: 0, wag7: 0, pay7: 0, maxp7: 0, b30: 0, w30: 0, wag30: 0, pay30: 0, maxp30: 0 };
      for (const s of db.sports_bets) {
        if (!['WON', 'LOST', 'CASHED_OUT'].includes(s.status)) continue;
        const ts = new Date(s.created_at).getTime();
        if (ts < c30) continue;
        const isWin = s.status === 'WON' || s.status === 'CASHED_OUT';
        const addWin = k => {
          acc['b' + k]++; acc['wag' + k] += s.stake; acc['pay' + k] += s.payout;
          if (isWin) { acc['w' + k]++; if (s.payout > acc['maxp' + k]) acc['maxp' + k] = s.payout; }
        };
        addWin('30');
        if (ts >= c7) addWin('7');
        if (ts >= c1) addWin('1');
      }
      return { rows: [acc], rowCount: 1 };
    }
    if (low.startsWith("select count(*) bets,coalesce(sum(stake),0) wagered,coalesce(sum(payout),0) paid from sports_bets")) {
      const list = db.sports_bets.filter(s => ['WON', 'LOST', 'CASHED_OUT'].includes(s.status));
      return { rows: [{ bets: list.length, wagered: list.reduce((a, b) => a + b.stake, 0), paid: list.reduce((a, b) => a + b.payout, 0) }], rowCount: 1 };
    }
    if (low.startsWith('select * from sports_bets where (ticket_id=$1 or bet_id=$1) and user_id=$2') ||
        low.startsWith('select * from sports_bets where ticket_id=$1 and user_id=$2')) {
      const s = db.sports_bets.find(x => (x.ticket_id === params[0] || x.bet_id === params[0]) && x.user_id === String(params[1]));
      return s ? { rows: [{ ...s }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith("update sports_bets set status='won'")) {
      const s = db.sports_bets.find(x => (x.ticket_id === params[1] || x.bet_id === params[1]) && x.status === 'IN_PLAY');
      if (s) { s.status = 'WON'; s.payout = Number(params[0]); s.settled_at = new Date(); }
      return { rows: [], rowCount: s ? 1 : 0 };
    }
    if (low.startsWith("update sports_bets set status='lost'")) {
      const s = db.sports_bets.find(x => (x.ticket_id === params[0] || x.bet_id === params[0]) && x.status === 'IN_PLAY');
      if (s) { s.status = 'LOST'; s.payout = 0; s.settled_at = new Date(); }
      return { rows: [], rowCount: s ? 1 : 0 };
    }
    if (low.startsWith("update sports_bets set status='cashed_out'")) {
      const s = db.sports_bets.find(x => (x.ticket_id === params[1] || x.bet_id === params[1]) && x.status === 'IN_PLAY');
      if (s) { s.status = 'CASHED_OUT'; s.payout = Number(params[0]); s.cashout_value = Number(params[0]); s.settled_at = new Date(); }
      return { rows: [], rowCount: s ? 1 : 0 };
    }
    if (low.includes("as game_name, user_id, stake as bet_amount, payout, status, created_at from sports_bets where status in ('won','lost','cashed_out','void') and created_at < $1")) {
      const cutoff = new Date(params[0]).getTime();
      const rows = db.sports_bets
        .filter(s => ['WON', 'LOST', 'CASHED_OUT', 'VOID'].includes(s.status) && new Date(s.created_at).getTime() < cutoff)
        .map(s => ({ bet_id: s.ticket_id || s.bet_id, game_name: 'Sportsbook', user_id: s.user_id, bet_amount: s.stake, payout: s.payout, status: s.status === 'CASHED_OUT' ? 'WON' : s.status, created_at: s.created_at }));
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("delete from sports_bets where status in ('won','lost','cashed_out','void') and created_at < $1")) {
      const cutoff = new Date(params[0]).getTime();
      const before = db.sports_bets.length;
      db.sports_bets = db.sports_bets.filter(s => !(['WON', 'LOST', 'CASHED_OUT', 'VOID'].includes(s.status) && new Date(s.created_at).getTime() < cutoff));
      return { rows: [], rowCount: before - db.sports_bets.length };
    }

    // ---- transactions ----
    if (low.startsWith('insert into transactions')) {
      let t;
      if (low.includes("'deposit'") && low.includes("'pending'")) {
        const [txn_id, user_id, username, method, amount, agent_assigned, bank_txn_id] = params;
        if (bank_txn_id && db.transactions.some(x => x.bank_txn_id === bank_txn_id)) throw dupErr();
        t = { txn_id, user_id: String(user_id), username, type: 'DEPOSIT', method, amount: Number(amount), net_amount: Number(amount), agent_assigned, bank_txn_id: bank_txn_id || null, status: 'PENDING', remarks: 'Pending cashier verification', created_at: new Date(), updated_at: new Date() };
      } else if (low.includes("'verifying'")) {
        const [txn_id, user_id, username, method, amount, bank_txn_id] = params;
        if (bank_txn_id && db.transactions.some(x => x.bank_txn_id === bank_txn_id)) throw dupErr();
        t = { txn_id, user_id: String(user_id), username, type: 'DEPOSIT', method, amount: Number(amount), net_amount: Number(amount), bank_txn_id: bank_txn_id || null, status: 'VERIFYING', remarks: 'Checking payment', processed_by: 'AUTO', created_at: new Date(), updated_at: new Date() };
      } else if (low.includes("'withdrawal'")) {
        const [txn_id, user_id, username, method, amount, sender_account, remarks] = params;
        t = { txn_id, user_id: String(user_id), username, type: 'WITHDRAWAL', method, amount: Number(amount), net_amount: Number(amount), sender_account, status: 'PENDING', remarks, created_at: new Date(), updated_at: new Date() };
      } else if (low.includes("'manual_1click'")) {
        const [txn_id, user_id, username, amount, bank_txn_id, processed_by] = params;
        if (bank_txn_id && db.transactions.some(x => x.bank_txn_id === bank_txn_id)) throw dupErr();
        t = { txn_id, user_id: String(user_id), username, type: 'DEPOSIT', method: 'Manual_1Click', amount: Number(amount), net_amount: Number(amount), bank_txn_id: bank_txn_id || null, status: 'APPROVED', processed_by, remarks: 'Manual top-up', created_at: new Date(), updated_at: new Date() };
      } else if (low.includes("'adjustment'")) {
        const [txn_id, user_id, amount, remarks, processed_by] = params;
        t = { txn_id, user_id: String(user_id), type: 'ADJUSTMENT', method: 'Adjustment', amount: Number(amount), net_amount: Number(amount), status: 'APPROVED', remarks, processed_by, created_at: new Date(), updated_at: new Date() };
      } else if (low.includes("'bonus'")) {
        const [txn_id, user_id, amount, remarks, processed_by] = params;
        const method = low.includes("'luckyspin'") ? 'LuckySpin' : low.includes("'firstdepositbonus'") ? 'FirstDepositBonus' : 'Cashback';
        t = { txn_id, user_id: String(user_id), type: 'BONUS', method, amount: Number(amount), net_amount: Number(amount), status: 'APPROVED', remarks, processed_by, created_at: new Date(), updated_at: new Date() };
      }
      if (t) db.transactions.unshift(t);
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith("select count(*) n from transactions where user_id=$1 and type='deposit' and status='pending'")) {
      const n = db.transactions.filter(t => t.user_id === String(params[0]) && t.type === 'DEPOSIT' && t.status === 'PENDING').length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    if (low.startsWith("select count(*) n from transactions where user_id=$1 and type='deposit' and status='failed'")) {
      const n = db.transactions.filter(t => t.user_id === String(params[0]) && t.type === 'DEPOSIT' && t.status === 'FAILED').length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    if (low.startsWith("select count(*) n from transactions where user_id=$1 and type='withdrawal' and status='pending'")) {
      const n = db.transactions.filter(t => t.user_id === String(params[0]) && t.type === 'WITHDRAWAL' && t.status === 'PENDING').length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    if (low.startsWith("select count(*) n from transactions where user_id=$1 and type='withdrawal' and status='approved'")) {
      const n = db.transactions.filter(t => t.user_id === String(params[0]) && t.type === 'WITHDRAWAL' && t.status === 'APPROVED').length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    if (low.startsWith("select coalesce(sum(amount),0) s,count(*) n from transactions")) {
      const cutoff = Date.now() - 86400e3;
      const list = db.transactions.filter(t => t.user_id === String(params[0]) && t.type === 'WITHDRAWAL' && ['PENDING', 'APPROVED'].includes(t.status) && new Date(t.created_at).getTime() >= cutoff);
      return { rows: [{ s: list.reduce((a, b) => a + b.amount, 0), n: String(list.length) }], rowCount: 1 };
    }
    if (low.startsWith("select coalesce(sum(amount),0) s from transactions where type='bonus'")) {
      const s = db.transactions.filter(t => t.type === 'BONUS').reduce((a, b) => a + b.amount, 0);
      return { rows: [{ s }], rowCount: 1 };
    }
    if (low.startsWith('select txn_id,type,method,amount,status,remarks,created_at from transactions')) {
      const rows = db.transactions.filter(t => t.user_id === String(params[0]) && ['DEPOSIT', 'WITHDRAWAL'].includes(t.type)).slice(0, 30);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select txn_id,user_id,status from transactions where bank_txn_id=$1')) {
      const t = db.transactions.find(x => x.bank_txn_id === params[0]);
      return t ? { rows: [{ txn_id: t.txn_id, user_id: t.user_id, status: t.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('select * from transactions where txn_id=$1')) {
      const t = db.transactions.find(x => {
        if (x.txn_id !== params[0]) return false;
        if (params[1] && x.user_id !== String(params[1])) return false;
        if (low.includes("status='pending'") && x.status !== 'PENDING') return false;
        if (low.includes("status='verifying'") && x.status !== 'VERIFYING') return false;
        if (low.includes("type='deposit'") && x.type !== 'DEPOSIT') return false;
        if (low.includes("type='withdrawal'") && x.type !== 'WITHDRAWAL') return false;
        return true;
      });
      return t ? { rows: [{ ...t }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith("select * from transactions where type='deposit' and status='pending'")) {
      const rows = db.transactions.filter(t => t.type === 'DEPOSIT' && t.status === 'PENDING').slice(0, 200);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("select * from transactions where type='withdrawal' and status='pending'")) {
      const rows = db.transactions.filter(t => t.type === 'WITHDRAWAL' && t.status === 'PENDING').slice(0, 200);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("select * from transactions where type='deposit' order by")) {
      const rows = db.transactions.filter(t => t.type === 'DEPOSIT').slice(0, 100);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith("select * from transactions where type='withdrawal' order by")) {
      const rows = db.transactions.filter(t => t.type === 'WITHDRAWAL').slice(0, 100);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select * from transactions order by')) {
      const rows = db.transactions.slice(0, 50);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('update transactions set bank_txn_id=null')) {
      db.transactions.forEach(t => { if (t.bank_txn_id === '') t.bank_txn_id = null; });
      return { rows: [], rowCount: 0 };
    }
    if (low.startsWith('update transactions set')) {
      if (low.startsWith("update transactions set status='verifying'") && params.length === 3) {
        const t = db.transactions.find(x => x.txn_id === params[2] && x.status === 'PENDING');
        if (!t) return { rows: [], rowCount: 0 };
        t.status = 'VERIFYING'; t.amount = Number(params[0]); t.net_amount = Number(params[0]); t.method = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (low.startsWith("update transactions set status='failed'")) {
        if (params.length === 0) return { rows: [], rowCount: 0 };
        const t = db.transactions.find(x => x.txn_id === params[1] && x.status === 'VERIFYING');
        if (t) { t.status = 'FAILED'; t.bank_txn_id = null; t.remarks = params[0]; t.updated_at = new Date(); }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      if (low.startsWith("update transactions set status='pending'")) {
        const t = db.transactions.find(x => x.txn_id === params[0] && x.status === 'VERIFYING');
        if (t) { t.status = 'PENDING'; t.remarks = 'Verified by gateway, waiting for cashier (large amount)'; t.updated_at = new Date(); }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      if (low.startsWith("update transactions set status='approved'") && low.includes("processed_by='auto'")) {
        const t = db.transactions.find(x => x.txn_id === params[0]);
        if (t) { t.status = 'APPROVED'; t.remarks = 'Auto-verified by gateway'; t.processed_by = 'AUTO'; t.updated_at = new Date(); }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      if (low.startsWith("update transactions set status='cancelled'")) {
        const t = db.transactions.find(x => x.txn_id === params[0]);
        if (t) { t.status = 'CANCELLED'; t.remarks = 'Cancelled by player'; t.updated_at = new Date(); }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      if (low.startsWith("update transactions set status='approved'") && params.length === 4) {
        const [remarks, actor, txnId, bankRef] = params;
        if (bankRef && db.transactions.some(x => x.bank_txn_id === bankRef && x.txn_id !== txnId)) throw dupErr();
        const t = db.transactions.find(x => x.txn_id === txnId);
        if (t) { t.status = 'APPROVED'; t.remarks = remarks; t.processed_by = actor; if (bankRef) t.bank_txn_id = bankRef; t.updated_at = new Date(); }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      if (low.startsWith("update transactions set status='rejected'") && low.includes('returning')) {
        const [reason, actor, txnId] = params;
        const t = db.transactions.find(x => x.txn_id === txnId && x.type === 'DEPOSIT' && x.status === 'PENDING');
        if (!t) return { rows: [], rowCount: 0 };
        t.status = 'REJECTED'; t.remarks = reason; t.processed_by = actor; t.updated_at = new Date();
        return { rows: [{ user_id: t.user_id, amount: t.amount }], rowCount: 1 };
      }
      if (low.startsWith("update transactions set status='approved'") && low.includes('returning')) {
        const [remarks, actor, txnId] = params;
        const t = db.transactions.find(x => x.txn_id === txnId && x.type === 'WITHDRAWAL' && x.status === 'PENDING');
        if (!t) return { rows: [], rowCount: 0 };
        t.status = 'APPROVED'; t.remarks = remarks; t.processed_by = actor; t.updated_at = new Date();
        return { rows: [{ user_id: t.user_id, amount: t.amount, method: t.method }], rowCount: 1 };
      }
      if (low.startsWith("update transactions set status='rejected'")) {
        const [remarks, actor, txnId] = params;
        const t = db.transactions.find(x => x.txn_id === txnId);
        if (t) { t.status = 'REJECTED'; t.remarks = remarks; t.processed_by = actor; t.updated_at = new Date(); }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }

    // ---- balance_audit_logs & admin_actions ----
    if (low.startsWith('insert into balance_audit_logs')) {
      const [user_id, action_type, amount, balance_before, balance_after, reference_id] = params;
      db.balance_audit_logs.unshift({ id: db.seq++, user_id, action_type, amount, balance_before, balance_after, reference_id, created_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('insert into admin_actions')) {
      const [actor, action, detail, ip] = params;
      db.admin_actions.unshift({ id: db.seq++, actor, action, detail, ip, created_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('select * from admin_actions')) {
      return { rows: db.admin_actions.slice(0, 200), rowCount: Math.min(200, db.admin_actions.length) };
    }

    // ---- promo_codes & promo_redemptions ----
    if (low.startsWith('select * from promo_codes order by code')) {
      const rows = [...db.promo_codes.values()].sort((a, b) => a.code.localeCompare(b.code));
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select * from promo_codes where code=$1')) {
      const p = db.promo_codes.get(params[0]);
      return p && p.is_active ? { rows: [{ ...p }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('insert into promo_codes')) {
      const m = sql.match(/values\s*\(\s*'([^']+)'\s*,\s*([0-9.]+)\s*,\s*([0-9]+)\s*\)/i);
      const code = m ? m[1] : params[0];
      const bonus_amount = m ? Number(m[2]) : Number(params[1]);
      const max_uses = m ? Number(m[3]) : Number(params[2]);
      if (db.promo_codes.has(code)) {
        if (low.includes('do nothing')) return { rows: [], rowCount: 0 };
        throw dupErr();
      }
      db.promo_codes.set(code, { code, bonus_amount, max_uses, times_used: 0, is_active: true });
      return { rows: [], rowCount: 1 };
    }
    if (low.startsWith('update promo_codes set times_used=times_used+1')) {
      const p = db.promo_codes.get(params[0]);
      if (p) p.times_used += 1;
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    if (low.startsWith('update promo_codes set is_active=not is_active')) {
      const p = db.promo_codes.get(params[0]);
      if (!p) return { rows: [], rowCount: 0 };
      p.is_active = !p.is_active;
      return { rows: [{ code: p.code, is_active: p.is_active }], rowCount: 1 };
    }
    if (low.startsWith('select 1 from promo_redemptions')) {
      const found = db.promo_redemptions.some(r => r.user_id === String(params[0]) && r.code === params[1]);
      return found ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('insert into promo_redemptions')) {
      const [user_id, code, amount_awarded] = params;
      db.promo_redemptions.push({ user_id: String(user_id), code, amount_awarded });
      return { rows: [], rowCount: 1 };
    }

    // ---- chat_messages ----
    if (low.startsWith('insert into chat_messages')) {
      const [user_id, username, message] = params;
      const row = { id: db.seq++, user_id: String(user_id), username, message, created_at: new Date() };
      db.chat_messages.push(row);
      if (db.chat_messages.length > 100) db.chat_messages = db.chat_messages.slice(-100);
      return { rows: [row], rowCount: 1 };
    }
    if (low.startsWith('select id,user_id,username,message,created_at from chat_messages')) {
      const lim = Number(params[0] || 30);
      const rows = db.chat_messages.slice(-lim).reverse();
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('delete from chat_messages')) {
      if (db.chat_messages.length > 100) db.chat_messages = db.chat_messages.slice(-100);
      return { rows: [], rowCount: 0 };
    }

    // ---- sms_agents & agent_deposits & cbe_transactions & telebirr_transactions ----
    if (low.startsWith('select id, name from sms_agents where token=$1')) {
      const a = db.sms_agents.find(x => x.token === params[0] && x.active);
      return a ? { rows: [{ id: a.id, name: a.name }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('select id, name, match_text from sms_agents')) {
      const rows = db.sms_agents.filter(x => x.active && x.match_text).map(x => ({ id: x.id, name: x.name, match_text: x.match_text }));
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select id, name, token, match_text, active, created_at from sms_agents')) {
      const rows = [...db.sms_agents].sort((a, b) => a.id - b.id);
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('insert into sms_agents')) {
      const [name, token, match_text] = params;
      if (db.sms_agents.some(x => x.token === token)) throw dupErr();
      const row = { id: db.seq++, name, token, match_text: match_text || '', active: true, created_at: new Date() };
      db.sms_agents.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (low.includes('from sms_agents a left join agent_deposits d')) {
      const todayKey = new Date().toISOString().slice(0, 10);
      const deposits = [
        ...db.cbe_transactions.filter(x => x.tx_type === 'Received').map(x => ({ ...x, bank: 'CBE' })),
        ...db.telebirr_transactions.filter(x => x.tx_type === 'Received').map(x => ({ ...x, bank: 'Telebirr' }))
      ];
      const rows = [...db.sms_agents].sort((a, b) => a.id - b.id).map(a => {
        const list = deposits.filter(d => d.agent_id === a.id);
        const total_in = list.reduce((s, x) => s + Number(x.amount), 0);
        const today_in = list.filter(x => new Date(x.created_at).toISOString().slice(0, 10) === todayKey).reduce((s, x) => s + Number(x.amount), 0);
        return { id: a.id, name: a.name, active: a.active, total_in, count_in: list.length, today_in };
      });
      return { rows, rowCount: rows.length };
    }
    if (low.includes('from agent_deposits where agent_id = $1')) {
      const [agentId, from, to, limitN] = params;
      const all = [
        ...db.cbe_transactions.filter(x => x.tx_type === 'Received' && x.agent_id === Number(agentId)).map(x => ({ bank: 'CBE', tx_id: x.id, amount: x.amount, ref_no: x.ref_no, sender_name: x.sender_name, balance: x.balance, status: x.status, created_at: x.created_at })),
        ...db.telebirr_transactions.filter(x => x.tx_type === 'Received' && x.agent_id === Number(agentId)).map(x => ({ bank: 'Telebirr', tx_id: x.id, amount: x.amount, ref_no: x.ref_no, sender_name: x.sender_name, balance: x.balance, status: x.status, created_at: x.created_at }))
      ]
        .filter(x => {
          const d = new Date(x.created_at).toISOString().slice(0, 10);
          return d >= String(from) && d <= String(to);
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, Number(limitN || 50));
      return { rows: all, rowCount: all.length };
    }

    if (low.startsWith('insert into cbe_transactions')) {
      const [tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, v2_code, agent_id] = params;
      if ((ref_no && db.cbe_transactions.some(x => x.ref_no === ref_no)) || (v2_code && db.cbe_transactions.some(x => x.v2_code === v2_code))) {
        return { rows: [], rowCount: 0 };
      }
      const row = {
        id: db.seq++, tx_type, sender_name, amount: Number(amount), ref_no: ref_no || null, raw_sms, status,
        category: category || null, balance: balance != null ? Number(balance) : null, v2_code: v2_code || null,
        resolve_attempts: 0, agent_id: agent_id || null, created_at: new Date()
      };
      db.cbe_transactions.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (low.startsWith('insert into telebirr_transactions')) {
      const [tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, agent_id] = params;
      if (ref_no && db.telebirr_transactions.some(x => x.ref_no === ref_no)) {
        return { rows: [], rowCount: 0 };
      }
      const row = {
        id: db.seq++, tx_type, sender_name, amount: Number(amount), ref_no, raw_sms, status,
        category: category || null, balance: balance != null ? Number(balance) : null,
        agent_id: agent_id || null, created_at: new Date()
      };
      db.telebirr_transactions.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (low.startsWith('select id, ref_no from cbe_transactions where v2_code=$1')) {
      const r = db.cbe_transactions.find(x => x.v2_code === params[0]);
      return r ? { rows: [{ id: r.id, ref_no: r.ref_no }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('select id from cbe_transactions where v2_code=$1 and ref_no is null')) {
      const r = db.cbe_transactions.find(x => x.v2_code === params[0] && !x.ref_no);
      return r ? { rows: [{ id: r.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('update cbe_transactions set ref_no=$1 where id=$2 and ref_no is null')) {
      if (db.cbe_transactions.some(x => x.ref_no === params[0])) throw dupErr();
      const r = db.cbe_transactions.find(x => x.id === Number(params[1]) && !x.ref_no);
      if (r) r.ref_no = params[0];
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (low.startsWith('delete from cbe_transactions where id=$1 and ref_no is null')) {
      const before = db.cbe_transactions.length;
      db.cbe_transactions = db.cbe_transactions.filter(x => !(x.id === Number(params[0]) && !x.ref_no));
      return { rows: [], rowCount: before - db.cbe_transactions.length };
    }
    if (low.includes('from cbe_transactions where ref_no is null and v2_code is not null')) {
      const rows = db.cbe_transactions
        .filter(x => !x.ref_no && x.v2_code && (x.resolve_attempts || 0) < 40)
        .sort((a, b) => a.id - b.id)
        .slice(0, 10)
        .map(x => ({ id: x.id, v2_code: x.v2_code }));
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('update cbe_transactions set resolve_attempts')) {
      const r = db.cbe_transactions.find(x => x.id === Number(params[0]));
      if (r) r.resolve_attempts = (r.resolve_attempts || 0) + 1;
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (low.includes('from cbe_transactions where ref_no is null order by id desc')) {
      const rows = db.cbe_transactions
        .filter(x => !x.ref_no)
        .sort((a, b) => b.id - a.id)
        .slice(0, 50)
        .map(x => ({ id: x.id, v2_code: x.v2_code, amount: x.amount, sender_name: x.sender_name, attempts: x.resolve_attempts || 0 }));
      return { rows, rowCount: rows.length };
    }
    if (low.startsWith('select * from cbe_transactions where ref_no = $1')) {
      const r = db.cbe_transactions.find(x => x.ref_no === params[0]);
      return r ? { rows: [{ ...r }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('select * from cbe_transactions where v2_code = $1')) {
      const r = db.cbe_transactions.find(x => x.v2_code === params[0]);
      return r ? { rows: [{ ...r }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith('select * from telebirr_transactions where ref_no = $1')) {
      const r = db.telebirr_transactions.find(x => x.ref_no === params[0]);
      return r ? { rows: [{ ...r }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (low.startsWith("update cbe_transactions set status = 'used' where id = $1")) {
      const r = db.cbe_transactions.find(x => x.id === Number(params[0]));
      if (r) r.status = 'Used';
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (low.startsWith("update telebirr_transactions set status = 'used' where id = $1")) {
      const r = db.telebirr_transactions.find(x => x.id === Number(params[0]));
      if (r) r.status = 'Used';
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (low.includes('from cbe_transactions order by id desc limit $1')) {
      const lim = Number(params[0] || 20);
      const rows = [...db.cbe_transactions].sort((a, b) => b.id - a.id).slice(0, lim);
      return { rows, rowCount: rows.length };
    }
    if (low.includes('from telebirr_transactions order by id desc limit $1')) {
      const lim = Number(params[0] || 20);
      const rows = [...db.telebirr_transactions].sort((a, b) => b.id - a.id).slice(0, lim);
      return { rows, rowCount: rows.length };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    _db: db,
    on: () => {},
    query: async (sql, params) => exec(sql, params),
    connect: async () => ({
      query: async (sql, params) => exec(sql, params),
      release: () => {}
    })
  };
}

module.exports = { createMockPool };
