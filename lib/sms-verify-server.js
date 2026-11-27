'use strict';
const https = require('https');
const crypto = require('crypto');

const CBE_HEADERS = {
  'X-App-ID': 'd1292e42-7400-49de-a2d3-9731caa4c819',
  'X-App-Version': '0a01980b-9859-1369-8198-59f403820000',
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

const safeEq = (a, b) => {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// ---------------- HELPERS / SMS PARSERS ----------------
const AM_IN = /ተቀብለዋል|ገቢ ሆኗል/;
const AM_OUT = /ከፍለዋል|ልከዋል|አስተላልፈዋል|ገዝተዋል|ተላልፏል/;
const NUM = '([0-9,]+(?:\\.[0-9]{1,2})?)';

function stripBalance(msg) {
  return String(msg || '').replace(/(?:ቀሪ\s*ሂሳብ|balance)[^0-9]{0,15}[0-9,]+(?:\.[0-9]{1,2})?\s*(?:ብር|ETB|Birr)?/ig, ' ');
}

function extractAmount(msg) {
  if (!msg) return 0;
  const m = stripBalance(msg);
  const match = m.match(new RegExp('(?:received|transferred|paid|credited|debited)\\s+(?:ETB|Birr)\\s*' + NUM, 'i'))
    || m.match(new RegExp('(?:received|transferred|paid|credited|debited)\\s+' + NUM + '\\s*(?:ETB|Birr)', 'i'))
    || m.match(new RegExp('(?:ETB|Birr)\\s*' + NUM, 'i'))
    || m.match(new RegExp(NUM + '\\s*ብር'));
  return match ? parseFloat(match[1].replace(/,/g, '')) : 0;
}

function extractBalance(msg) {
  const m = String(msg || '').match(/(?:ቀሪ\s*ሂሳብ|balance(?:\s+is)?)[^0-9]{0,25}([0-9,]+(?:\.[0-9]{1,2})?)/i);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function extractTelebirrRef(msg) {
  const s = String(msg || '');
  const am = s.match(/(?:የግብይት|የሂሳብ\s*እንቅስቃሴ)\s*ቁጥርዎ\s*([A-Z0-9]{8,14})/i);
  if (am) return am[1].toUpperCase();
  const en = s.match(/transaction\s*(?:number|no|id)\s*(?:is)?[\s:]*((?=[A-Z0-9]*\d)[A-Z0-9]{8,14})\b/i);
  return en ? en[1].toUpperCase() : null;
}

function extractDirectFt(msg) {
  const m = String(msg || '').match(/\b(FT[A-Z0-9]{8,15})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function normV2(code) {
  return 'v2-' + String(code || '').replace(/^v2-/i, '');
}

function extractV2Code(msg) {
  const m = String(msg || '').match(/cbe\.com\.et\/(v2-[A-Za-z0-9_-]+)/i);
  return m ? normV2(m[1]) : null;
}

function extractParty(msg, isIncoming, bank) {
  const s = String(msg || '');
  if (bank === 'CBE') {
    for (const g of s.matchAll(/\(([^)]+)\)/g)) {
      if (/[A-Za-z]{3,}/.test(g[1]) && !/%/.test(g[1])) return g[1].trim().slice(0, 100);
    }
    const f = isIncoming ? s.match(/from\s+([A-Za-z0-9\s*]+)/i) : s.match(/to\s+([A-Za-z0-9\s*]+)/i);
    return f ? f[1].trim().slice(0, 100) : 'CBE Client';
  }
  if (AM_IN.test(s) || AM_OUT.test(s)) {
    const m = isIncoming ? s.match(/ከ\s+(.+?)\s*\(/) : s.match(/ለ\s+(\S+)/);
    return m ? m[1].trim().slice(0, 100) : 'Telebirr Client';
  }
  const m = isIncoming ? s.match(/from\s+([^(]+)\(/i) : s.match(/to\s+([^(]+)\(/i);
  return m ? m[1].trim().slice(0, 100) : 'Telebirr Client';
}

function extractRecipientAccount(msg, bank) {
  const s = String(msg || '');
  if (bank === 'CBE') {
    const toAcc = s.match(/to\s+account\s+([0-9*]{6,20})/i);
    if (toAcc) return toAcc[1];
    const anyAcc = s.match(/account\s+([0-9*]{6,20})/i);
    return anyAcc ? anyAcc[1] : '';
  }
  const parenPhone = s.match(/\((2519[0-9*]{5,10}|09[0-9*]{7,9}|251[0-9*]{8,10})\)/);
  if (parenPhone) return parenPhone[1];
  const barePhone = s.match(/\b(2519[0-9*]{5,10}|09[0-9]{8})\b/);
  return barePhone ? barePhone[1] : '';
}

function accountLastDigitsMatch(accA, accB) {
  const cleanA = String(accA || '').replace(/[^0-9]/g, '');
  const cleanB = String(accB || '').replace(/[^0-9]/g, '');
  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;
  const tailA = cleanA.slice(-4);
  const tailB = cleanB.slice(-4);
  return tailA.length === 4 && tailB.length === 4 && tailA === tailB;
}

function normalizePersonName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u1200-\u137f\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const s = String(a || ''), t = String(b || '');
  const m = s.length, n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

function fuzzyNameMatch(queryName, candidateName) {
  const q = normalizePersonName(queryName);
  const c = normalizePersonName(candidateName);
  if (!q || !c) return { matched: false, score: 0, distance: 99, mode: 'none' };
  if (q === c) return { matched: true, score: 100, distance: 0, mode: 'exact_full' };

  const qTokens = q.split(' ').filter(Boolean);
  const cTokens = c.split(' ').filter(Boolean);
  const qFirst = qTokens[0] || '';
  const cFirst = cTokens[0] || '';
  if (qFirst && cFirst && qFirst.length >= 3 && qFirst === cFirst) {
    if (qTokens.length >= 2 && cTokens.length >= 2) {
      const qRest = qTokens.slice(1).join(' ');
      const cRest = cTokens.slice(1).join(' ');
      const dRest = levenshtein(qRest, cRest);
      if (dRest <= 2) return { matched: true, score: 96 - dRest * 3, distance: dRest, mode: 'fuzzy_last' };
      const qSec = qTokens[1], cSec = cTokens[1];
      if (qSec && cSec && levenshtein(qSec, cSec) <= 2) {
        return { matched: true, score: 92, distance: levenshtein(qSec, cSec), mode: 'fuzzy_father' };
      }
    }
    return { matched: true, score: 90, distance: 0, mode: 'exact_first' };
  }

  const maxEdits = len => (len >= 7 ? 2 : len >= 4 ? 1 : 0);
  const dFull = levenshtein(q, c);
  const fullLimit = Math.min(2, maxEdits(Math.max(q.length, c.length)));
  if (dFull <= fullLimit) {
    return { matched: true, score: 88 - dFull * 4, distance: dFull, mode: 'fuzzy_full' };
  }

  if (qFirst.length >= 4 && cFirst.length >= 4) {
    const dFirst = levenshtein(qFirst, cFirst);
    if (dFirst <= maxEdits(Math.max(qFirst.length, cFirst.length))) {
      if (qTokens.length === 1 || cTokens.length === 1) {
        return { matched: true, score: 82 - dFirst * 5, distance: dFirst, mode: 'fuzzy_first' };
      }
      const dPair = levenshtein(`${qFirst} ${qTokens[1]}`, `${cFirst} ${cTokens[1]}`);
      if (dPair <= 2) {
        return { matched: true, score: 84 - dPair * 4, distance: dPair, mode: 'fuzzy_pair' };
      }
      return { matched: true, score: 74 - dFirst * 4, distance: dFirst, mode: 'fuzzy_first_only' };
    }
  }
  return { matched: false, score: 0, distance: dFull, mode: 'none' };
}

function detectCategory(msg, isIncoming) {
  const s = String(msg || '');
  if (isIncoming) return 'Received';
  if (/has been debited with ETB\s*[0-9,.]+\s*including Service charge/i.test(s) && !/to account/i.test(s)) return 'ATM/Card';
  if (/አየር\s*ሰዓት|የአየር|airtime|recharge|top\s*up/i.test(s)) return 'Airtime';
  if (/ኢንተርኔት|ዳታ|ጥቅል|data|package|bundle/i.test(s)) return 'Data';
  if (/ከፍለዋል|paid|purchase/i.test(s)) return 'Payment';
  return 'Transfer';
}

function classify(message, sender) {
  const msg = String(message || '').replace(/\r?\n/g, ' ').trim();
  const snd = String(sender || '');
  let isCbe;
  if (/^\s*127\s*$|telebirr/i.test(snd)) isCbe = false;
  else if (/cbe/i.test(snd)) isCbe = true;
  else isCbe = /cbe\.com\.et|\bFT[A-Z0-9]{8,15}\b|from account\s+[0-9*]+|banking with CBE/i.test(msg);
  const bank = isCbe ? 'CBE' : 'Telebirr';
  const outEn = isCbe ? /you have (?:successfully )?transferred|has been debited|a debit transaction/i : /you have (?:successfully )?transferred|you have paid/i;
  const inEn = isCbe ? /you have received|has been credited|a credit transaction/i : /you have received/i;
  const inPos = msg.search(inEn), outPos = msg.search(outEn);
  let isIncoming = inEn.test(msg) || (!isCbe && AM_IN.test(msg));
  let isOutgoing = outEn.test(msg) || (!isCbe && AM_OUT.test(msg));
  if (isIncoming && isOutgoing) {
    if (outPos >= 0 && (inPos < 0 || outPos < inPos)) isIncoming = false; else isOutgoing = false;
  }
  return { msg, isCbe, bank, isIncoming, isOutgoing };
}

function parseVerifyInput(refIn, smsIn) {
  const text = String(smsIn || refIn || '').trim();
  if (!text) return null;
  const long = text.length > 30;
  const amount = long ? extractAmount(text) : 0;
  const ft = extractDirectFt(text);
  if (ft) return { type: 'ft', value: ft, amount };
  const v2 = text.match(/\b(v2-[A-Za-z0-9_-]{6,})/i);
  if (v2) return { type: 'v2', value: normV2(v2[1]), amount };
  const rc = text.match(/receipt\/([A-Z0-9]{8,14})\b/i);
  const tb = rc ? rc[1].toUpperCase() : extractTelebirrRef(text) || (/^[A-Za-z0-9]{8,14}$/.test(text) ? text.toUpperCase() : null);
  return tb ? { type: 'tb', value: tb, amount } : null;
}

// ---------------- CBE HTTPS LOOKUP ----------------
function fetchHttps(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET', headers: headers || CBE_HEADERS, rejectUnauthorized: false, timeout: 6000
    }, res => {
      let data = '';
      res.on('data', c => { if (data.length < 300000) data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function cbeTargets(code) {
  const raw = String(code || '').replace(/^v2-/i, '');
  const enc = encodeURIComponent;
  return [
    { name: 'api-v2', host: 'mb.cbe.com.et', path: `/api/v1/transactions/public/transaction-detail/${enc('v2-' + raw)}`, headers: CBE_HEADERS },
    { name: 'api-raw', host: 'mb.cbe.com.et', path: `/api/v1/transactions/public/transaction-detail/${enc(raw)}`, headers: CBE_HEADERS },
    { name: 'receipt-page', host: 'mbreciept.cbe.com.et', path: `/${enc('v2-' + raw)}`, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/json' } }
  ];
}

async function resolveFtNumber(v2Code, attempts = 1) {
  if (!v2Code) return null;
  for (let i = 0; i < attempts; i++) {
    for (const t of cbeTargets(v2Code)) {
      try {
        const r = await fetchHttps(t.host, t.path, t.headers);
        const m = r.body.match(/\b(FT[A-Z0-9]{8,15})\b/i);
        if (m) return m[1].toUpperCase();
      } catch (_) {}
    }
    if (i < attempts - 1) await sleep(1500);
  }
  return null;
}

// ---------------- INTEGRATED VERIFY SERVER ENGINE ----------------
function createSmsVerifyService({ pool, env = process.env, admin, h }) {
  let secretToken = env.SECRET_TOKEN || env.VERIFI_TOKEN || '';
  const verifyToken = env.VERIFY_TOKEN || env.VERIFI_TOKEN || '';
  let resolverBusy = false;

  async function ensureSchemaAndToken() {
    const DDL = [
      `CREATE TABLE IF NOT EXISTS sms_agents (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        token VARCHAR(128) UNIQUE NOT NULL,
        match_text VARCHAR(255) DEFAULT '',
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS cbe_transactions (
        id SERIAL PRIMARY KEY,
        tx_type VARCHAR(32) NOT NULL,
        sender_name VARCHAR(255),
        amount NUMERIC(14,2) NOT NULL,
        ref_no VARCHAR(64) UNIQUE,
        raw_sms TEXT,
        status VARCHAR(32) DEFAULT 'Unused',
        category VARCHAR(64),
        balance NUMERIC(14,2),
        v2_code VARCHAR(128) UNIQUE,
        resolve_attempts INTEGER DEFAULT 0,
        agent_id INTEGER REFERENCES sms_agents(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS telebirr_transactions (
        id SERIAL PRIMARY KEY,
        tx_type VARCHAR(32) NOT NULL,
        sender_name VARCHAR(255),
        amount NUMERIC(14,2) NOT NULL,
        ref_no VARCHAR(64) UNIQUE NOT NULL,
        raw_sms TEXT,
        status VARCHAR(32) DEFAULT 'Unused',
        category VARCHAR(64),
        balance NUMERIC(14,2),
        agent_id INTEGER REFERENCES sms_agents(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `ALTER TABLE cbe_transactions ADD COLUMN IF NOT EXISTS agent_id INTEGER, ADD COLUMN IF NOT EXISTS v2_code VARCHAR(128), ADD COLUMN IF NOT EXISTS resolve_attempts INTEGER DEFAULT 0, ADD COLUMN IF NOT EXISTS category VARCHAR(64), ADD COLUMN IF NOT EXISTS balance NUMERIC(14,2), ADD COLUMN IF NOT EXISTS recipient_account VARCHAR(64) DEFAULT '', ADD COLUMN IF NOT EXISTS claimed_by_user_id VARCHAR(64) DEFAULT '', ADD COLUMN IF NOT EXISTS claimed_by_username VARCHAR(128) DEFAULT '', ADD COLUMN IF NOT EXISTS claimed_txn_id VARCHAR(64) DEFAULT ''`,
      `ALTER TABLE telebirr_transactions ADD COLUMN IF NOT EXISTS agent_id INTEGER, ADD COLUMN IF NOT EXISTS category VARCHAR(64), ADD COLUMN IF NOT EXISTS balance NUMERIC(14,2), ADD COLUMN IF NOT EXISTS recipient_account VARCHAR(64) DEFAULT '', ADD COLUMN IF NOT EXISTS claimed_by_user_id VARCHAR(64) DEFAULT '', ADD COLUMN IF NOT EXISTS claimed_by_username VARCHAR(128) DEFAULT '', ADD COLUMN IF NOT EXISTS claimed_txn_id VARCHAR(64) DEFAULT ''`,
      `CREATE INDEX IF NOT EXISTS idx_cbe_v2_pending ON cbe_transactions (id) WHERE ref_no IS NULL AND v2_code IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_cbe_ref ON cbe_transactions (ref_no)`,
      `CREATE INDEX IF NOT EXISTS idx_tb_ref ON telebirr_transactions (ref_no)`,
      `CREATE OR REPLACE VIEW agent_deposits AS
       SELECT 'CBE'::text AS bank, id AS tx_id, amount, ref_no, sender_name, recipient_account, balance, status, agent_id, claimed_by_user_id, claimed_by_username, claimed_txn_id, created_at
       FROM cbe_transactions WHERE tx_type = 'Received'
       UNION ALL
       SELECT 'Telebirr'::text AS bank, id AS tx_id, amount, ref_no, sender_name, recipient_account, balance, status, agent_id, claimed_by_user_id, claimed_by_username, claimed_txn_id, created_at
       FROM telebirr_transactions WHERE tx_type = 'Received'`,
      `CREATE OR REPLACE VIEW agent_payouts AS
       SELECT 'CBE'::text AS bank, id AS tx_id, amount, ref_no, sender_name, recipient_account, balance, status, agent_id, claimed_by_user_id, claimed_by_username, claimed_txn_id, created_at
       FROM cbe_transactions WHERE tx_type = 'Transferred'
       UNION ALL
       SELECT 'Telebirr'::text AS bank, id AS tx_id, amount, ref_no, sender_name, recipient_account, balance, status, agent_id, claimed_by_user_id, claimed_by_username, claimed_txn_id, created_at
       FROM telebirr_transactions WHERE tx_type = 'Transferred'`
    ];
    for (const s of DDL) {
      await pool.query(s).catch(e => console.warn('sms schema step:', e.message.slice(0, 120)));
    }
    if (!secretToken) {
      try {
        const cur = await pool.query(`SELECT value FROM system_settings WHERE key='sms_secret_token'`);
        if (cur.rows.length && cur.rows[0].value) {
          secretToken = cur.rows[0].value;
        } else {
          const generated = crypto.randomBytes(24).toString('hex');
          await pool.query(
            `INSERT INTO system_settings (key,value) VALUES ('sms_secret_token',$1) ON CONFLICT (key) DO NOTHING`,
            [generated]
          );
          const re = await pool.query(`SELECT value FROM system_settings WHERE key='sms_secret_token'`);
          secretToken = re.rows[0]?.value || generated;
        }
      } catch (_) {
        secretToken = crypto.randomBytes(24).toString('hex');
      }
    }
  }

  function getTokens() {
    return {
      secretToken,
      verifyToken: verifyToken || secretToken,
      isEnvConfigured: Boolean(env.SECRET_TOKEN || env.VERIFI_TOKEN)
    };
  }

  async function settleFt(id, ft) {
    try {
      await pool.query('UPDATE cbe_transactions SET ref_no=$1 WHERE id=$2 AND ref_no IS NULL', [ft, id]);
      return 'Resolved';
    } catch (e) {
      if (e.code === '23505') {
        await pool.query('DELETE FROM cbe_transactions WHERE id=$1 AND ref_no IS NULL', [id]);
        return 'Duplicate';
      }
      throw e;
    }
  }

  async function resolvePending() {
    if (resolverBusy) return;
    resolverBusy = true;
    try {
      const { rows } = await pool.query(
        `SELECT id, v2_code FROM cbe_transactions
         WHERE ref_no IS NULL AND v2_code IS NOT NULL AND COALESCE(resolve_attempts,0) < 40
         ORDER BY id LIMIT 10`
      );
      for (const row of rows) {
        const ft = await resolveFtNumber(row.v2_code, 1);
        if (ft) await settleFt(row.id, ft);
        else await pool.query('UPDATE cbe_transactions SET resolve_attempts = COALESCE(resolve_attempts,0)+1 WHERE id=$1', [row.id]);
      }
    } catch (e) {
      console.error('sms resolver:', e.message);
    } finally {
      resolverBusy = false;
    }
  }

  function startCbeBackgroundResolver() {
    setInterval(() => resolvePending().catch(() => {}), 20000).unref();
    setTimeout(() => resolvePending().catch(() => {}), 5000).unref();
  }

  function auth(req, res) {
    const tk = req.query.token || req.headers['x-verify-token'];
    if (!safeEq(tk, secretToken)) {
      res.status(401).json({ status: 'Unauthorized' });
      return false;
    }
    return true;
  }

  function authVerify(req, res) {
    const tk = req.query.token || req.headers['x-verify-token'];
    if (safeEq(tk, secretToken) || (verifyToken && safeEq(tk, verifyToken))) return true;
    res.status(401).json({ status: 'Unauthorized' });
    return false;
  }

  async function findAgentByToken(tk) {
    if (!tk) return null;
    const r = await pool.query('SELECT id, name FROM sms_agents WHERE token=$1 AND active', [tk]);
    return r.rows[0] || null;
  }

  async function findAgentByMsg(msg) {
    const r = await pool.query("SELECT id, name, match_text FROM sms_agents WHERE active AND COALESCE(match_text,'') <> ''");
    return r.rows.find(a => msg.includes(a.match_text)) || null;
  }

  async function locate(inp) {
    if (inp.type === 'tb') return { table: 'telebirr_transactions', col: 'ref_no', val: inp.value, bank: 'Telebirr' };
    const o = { table: 'cbe_transactions', bank: 'CBE', col: 'ref_no', val: inp.value };
    if (inp.type === 'v2') {
      o.col = 'v2_code';
      const r = await pool.query('SELECT id, ref_no FROM cbe_transactions WHERE v2_code=$1', [inp.value]);
      if (!r.rows.length || !r.rows[0].ref_no) {
        const ft = await resolveFtNumber(inp.value, 1);
        if (ft) {
          if (r.rows.length) await settleFt(r.rows[0].id, ft).catch(() => {});
          o.col = 'ref_no';
          o.val = ft;
        }
      }
    }
    return o;
  }

  async function verifyPaymentDirect(refIn, amountIn, smsIn = '', claimMeta = null) {
    const inp = parseVerifyInput(refIn, smsIn);
    if (!inp) return { status: 'Missing_Ref' };
    let expectedAmount = parseFloat(amountIn);
    if (isNaN(expectedAmount) && inp.amount) expectedAmount = inp.amount;
    if (isNaN(expectedAmount) || expectedAmount <= 0) return { status: 'Missing_Amount' };

    let table, col, val, bankName;
    if (inp.type === 'tb') {
      table = 'telebirr_transactions'; col = 'ref_no'; val = inp.value; bankName = 'Telebirr';
    } else {
      table = 'cbe_transactions'; bankName = 'CBE';
      if (inp.type === 'ft') {
        col = 'ref_no'; val = inp.value;
      } else {
        col = 'v2_code'; val = inp.value;
        const r = await pool.query('SELECT id, ref_no FROM cbe_transactions WHERE v2_code=$1', [val]);
        if (!r.rows.length || !r.rows[0].ref_no) {
          const ft = await resolveFtNumber(val, 1);
          if (ft) {
            if (r.rows.length) await settleFt(r.rows[0].id, ft).catch(() => {});
            col = 'ref_no'; val = ft;
          }
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selectSql = table === 'telebirr_transactions'
        ? 'SELECT * FROM telebirr_transactions WHERE ref_no = $1 FOR UPDATE'
        : (col === 'ref_no'
            ? 'SELECT * FROM cbe_transactions WHERE ref_no = $1 FOR UPDATE'
            : 'SELECT * FROM cbe_transactions WHERE v2_code = $1 FOR UPDATE');
      const result = await client.query(selectSql, [val]);
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return { status: 'Pending', bank: bankName };
      }
      const tx = result.rows[0];
      if (tx.tx_type !== 'Received' || tx.status === 'Audit_Only') {
        await client.query('ROLLBACK');
        return { status: 'Invalid_Transaction_Type', bank: bankName };
      }
      if (!tx.ref_no) {
        await client.query('ROLLBACK');
        return { status: 'Resolving', bank: bankName };
      }
      if (tx.status !== 'Unused') {
        await client.query('ROLLBACK');
        return { status: 'AlreadyUsed', bank: bankName, claimed_by: tx.claimed_by_username || null };
      }
      const actualAmount = parseFloat(tx.amount);
      if (Math.abs(actualAmount - expectedAmount) > 0.001) {
        await client.query('ROLLBACK');
        return { status: 'InvalidAmount', expected: expectedAmount, actual: actualAmount, bank: bankName };
      }
      const cUid = String(claimMeta?.userId || '').slice(0, 64);
      const cUname = String(claimMeta?.username || '').slice(0, 128);
      const cTxn = String(claimMeta?.txnId || '').slice(0, 64);
      const updateSql = table === 'telebirr_transactions'
        ? "UPDATE telebirr_transactions SET status = 'Used', claimed_by_user_id = $2, claimed_by_username = $3, claimed_txn_id = $4 WHERE id = $1"
        : "UPDATE cbe_transactions SET status = 'Used', claimed_by_user_id = $2, claimed_by_username = $3, claimed_txn_id = $4 WHERE id = $1";
      await client.query(updateSql, [tx.id, cUid, cUname, cTxn]);
      let agentName = null;
      if (tx.agent_id) {
        const ag = await client.query('SELECT name FROM sms_agents WHERE id=$1', [tx.agent_id]).catch(() => ({ rows: [] }));
        agentName = ag.rows[0]?.name || null;
      }
      await client.query('COMMIT');
      return {
        status: 'Verified',
        bank: bankName,
        amount: actualAmount,
        ref_no: tx.ref_no,
        from_to: tx.sender_name,
        recipient_account: tx.recipient_account || '',
        claimed_by: cUname || cUid || null,
        agent_id: tx.agent_id || null,
        agent_name: agentName,
        agent: agentName || 'Owner'
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  async function resolveAgentName(agentId) {
    if (!agentId) return 'Owner';
    const ag = await pool.query('SELECT name FROM sms_agents WHERE id=$1', [agentId]).catch(() => ({ rows: [] }));
    return ag.rows[0]?.name || 'Owner';
  }

  async function claimLockedPayoutRow(tbl, rowId, txnId, actor) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(`SELECT * FROM ${tbl} WHERE id=$1 FOR UPDATE`, [rowId]);
      if (!cur.rows.length) {
        await client.query('ROLLBACK');
        return { ok: false, status: 'Not_Found', reason: 'Payout SMS row no longer exists' };
      }
      const locked = cur.rows[0];
      if (locked.status === 'Audit_Only' || locked.tx_type !== 'Transferred') {
        await client.query('ROLLBACK');
        return { ok: false, status: 'Invalid_Transaction_Type', reason: 'Audit_Only or incoming SMS cannot match withdrawals' };
      }
      if ((locked.claimed_txn_id && locked.claimed_txn_id !== txnId) || (locked.status === 'Payout_Verified' && locked.claimed_txn_id !== txnId)) {
        await client.query('ROLLBACK');
        return { ok: false, status: 'AlreadyUsed', reason: `Payout already claimed by ${locked.claimed_txn_id || 'another withdrawal'}` };
      }
      if (locked.status !== 'Sent_Locked' && locked.claimed_txn_id !== txnId) {
        await client.query('ROLLBACK');
        return { ok: false, status: 'AlreadyUsed', reason: `Row status is ${locked.status}` };
      }
      await client.query(
        `UPDATE ${tbl} SET status='Payout_Verified', claimed_txn_id=$2, claimed_by_username=$3 WHERE id=$1`,
        [rowId, String(txnId || '').slice(0, 64), String(actor || '').slice(0, 128)]
      );
      await client.query('COMMIT');
      return { ok: true, row: locked };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  async function matchWithdrawalSms({ txnId, method, amount, recipientAccount, customerName, ref, actor, readOnly = false }) {
    const cleanRef = String(ref || '').trim().toUpperCase();
    const cleanName = String(customerName || '').trim();
    const targetAmt = parseFloat(amount);
    const tables = method === 'CBE' ? ['cbe_transactions'] : method === 'Telebirr' ? ['telebirr_transactions'] : ['telebirr_transactions', 'cbe_transactions'];

    if (cleanRef) {
      for (const tbl of tables) {
        const bankName = tbl === 'cbe_transactions' ? 'CBE' : 'Telebirr';
        const r = await pool.query(`SELECT * FROM ${tbl} WHERE (ref_no=$1${tbl === 'cbe_transactions' ? ' OR v2_code=$1' : ''}) LIMIT 1`, [cleanRef]);
        if (!r.rows.length) continue;
        const row = r.rows[0];
        if (row.tx_type !== 'Transferred' || row.status === 'Audit_Only') {
          return { matched: false, status: 'Invalid_Transaction_Type', bank: bankName, reason: 'This SMS is Audit_Only or Received (not an outgoing transfer)' };
        }
        if ((row.status === 'Payout_Verified' || row.claimed_txn_id) && row.claimed_txn_id !== txnId) {
          return { matched: false, status: 'AlreadyUsed', bank: bankName, reason: `Reference ${cleanRef} already linked to ${row.claimed_txn_id || 'another payout'}` };
        }
        if (Number.isFinite(targetAmt) && Math.abs(parseFloat(row.amount) - targetAmt) > 0.05) {
          return { matched: false, status: 'InvalidAmount', bank: bankName, expected: targetAmt, actual: parseFloat(row.amount), reason: `SMS amount (${row.amount} ETB) does not match withdrawal (${targetAmt} ETB)` };
        }
        if (!readOnly) {
          const lockRes = await claimLockedPayoutRow(tbl, row.id, txnId, actor);
          if (!lockRes.ok) return { matched: false, status: lockRes.status, bank: bankName, reason: lockRes.reason };
        }
        const agentName = await resolveAgentName(row.agent_id);
        return {
          matched: true,
          status: readOnly ? 'Found' : 'Verified',
          bank: bankName,
          ref: row.ref_no || row.v2_code || cleanRef,
          amount: parseFloat(row.amount),
          party: row.sender_name,
          recipientAccount: row.recipient_account || '',
          agentId: row.agent_id || null,
          agentName,
          matchMode: 'ref'
        };
      }
      return { matched: false, status: 'Not_Found', reason: `No Sent_Locked outgoing payout SMS found for ref ${cleanRef}` };
    }

    let bestCandidate = null;
    for (const tbl of tables) {
      const bankName = tbl === 'cbe_transactions' ? 'CBE' : 'Telebirr';
      const r = await pool.query(`SELECT * FROM ${tbl} WHERE tx_type='Transferred' AND status='Sent_Locked' AND COALESCE(claimed_txn_id,'')='' ORDER BY id DESC LIMIT 100`);
      for (const row of r.rows) {
        if (row.status === 'Audit_Only') continue;
        if (Number.isFinite(targetAmt) && Math.abs(parseFloat(row.amount) - targetAmt) > 0.05) continue;
        const accOk = Boolean(recipientAccount && row.recipient_account && accountLastDigitsMatch(recipientAccount, row.recipient_account));
        const accConflict = Boolean(recipientAccount && row.recipient_account && !accOk);
        const nm = cleanName ? fuzzyNameMatch(cleanName, row.sender_name) : { matched: false, score: 0, mode: 'none' };

        if (cleanName && !nm.matched && !accOk) continue;
        if (!cleanName && recipientAccount && !accOk) continue;
        if (accConflict && !nm.matched) continue;

        const score = (nm.matched ? nm.score : 0) + (accOk ? 50 : 0) + (!cleanName && !recipientAccount ? 10 : 0);
        if (!bestCandidate || score > bestCandidate.score) {
          bestCandidate = {
            tbl,
            bankName,
            row,
            score,
            matchMode: accOk && nm.matched ? 'name+account' : (nm.matched ? nm.mode : (accOk ? 'account' : 'amount'))
          };
        }
      }
    }

    if (bestCandidate) {
      const { tbl, bankName, row, matchMode, score } = bestCandidate;
      if (!readOnly) {
        const lockRes = await claimLockedPayoutRow(tbl, row.id, txnId, actor);
        if (!lockRes.ok) return { matched: false, status: lockRes.status, bank: bankName, reason: lockRes.reason };
      }
      const agentName = await resolveAgentName(row.agent_id);
      return {
        matched: true,
        status: readOnly ? 'Found' : 'Verified',
        bank: bankName,
        ref: row.ref_no || row.v2_code || `SMS-${row.id}`,
        amount: parseFloat(row.amount),
        party: row.sender_name,
        recipientAccount: row.recipient_account || '',
        agentId: row.agent_id || null,
        agentName,
        matchMode,
        matchScore: score
      };
    }

    return { matched: false, status: 'Not_Found', reason: 'No matching outgoing Sent_Locked payout SMS found yet' };
  }

  function mountRoutes(app) {
    // Allow SMS forwarders that send GET or POST (url-encoded / JSON / query string)
    app.use('/webhook/sms', (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'POST') return next();
      return smsWebhookHandler(req, res);
    });

    async function smsWebhookHandler(req, res) {
      const authHeader = String(req.headers.authorization || '');
      const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
      const tokenIn = String(req.query.token || req.body?.token || req.headers['x-verify-token'] || req.headers['x-webhook-token'] || bearer || '');
      let agent = null;
      if (!safeEq(tokenIn, secretToken)) {
        try { agent = await findAgentByToken(tokenIn); }
        catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
        if (!agent) return res.status(401).json({ status: 'Unauthorized' });
      }
      const message = req.query.message ?? req.query.msg ?? req.query.text ?? req.query.sms ?? req.query.content ?? req.query.body
        ?? req.body?.message ?? req.body?.msg ?? req.body?.text ?? req.body?.sms ?? req.body?.content ?? req.body?.body ?? req.body?.raw_sms;
      const sender = req.query.sender ?? req.query.from ?? req.query.phone ?? req.query.address
        ?? req.body?.sender ?? req.body?.from ?? req.body?.phone ?? req.body?.address ?? '';
      if (!message) return res.status(400).json({ status: 'Error', message: 'No SMS provided' });

      const c = classify(message, sender);
      if (!c.isIncoming && !c.isOutgoing) return res.json({ status: 'Ignored', reason: 'Not a payment SMS' });

      if (!agent && c.isIncoming) {
        try { agent = await findAgentByMsg(c.msg); } catch (e) { console.error(e); }
      }
      const agentId = agent ? agent.id : null;

      const amount = extractAmount(c.msg);
      const balance = extractBalance(c.msg);
      const party = extractParty(c.msg, c.isIncoming, c.bank);
      const recipientAccount = extractRecipientAccount(c.msg, c.bank);
      const category = detectCategory(c.msg, c.isIncoming);
      let ref = null, v2 = null;

      if (c.isCbe) {
        ref = extractDirectFt(c.msg);
        v2 = extractV2Code(c.msg);
        if (!ref && v2) ref = await resolveFtNumber(v2, 1);
        if (!ref && !v2) ref = 'CBE-' + crypto.createHash('sha1').update(c.msg).digest('hex').slice(0, 12).toUpperCase();
      } else {
        ref = extractTelebirrRef(c.msg);
        if (!ref) return res.json({ status: 'Ignored', reason: 'Missing Ref' });
      }
      if (!amount) return res.json({ status: 'Ignored', reason: 'Missing Amount' });

      const txType = c.isIncoming ? 'Received' : 'Transferred';
      const isAuditOnly = !c.isIncoming && ['ATM/Card', 'Airtime', 'Data', 'Payment'].includes(category);
      const status = c.isIncoming ? 'Unused' : (isAuditOnly ? 'Audit_Only' : 'Sent_Locked');

      try {
        let result;
        if (c.isCbe) {
          result = await pool.query(
            `INSERT INTO cbe_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, v2_code, agent_id, recipient_account)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
            [txType, party, amount, ref, c.msg, status, category, balance, v2, agentId, recipientAccount]
          );
        } else {
          result = await pool.query(
            `INSERT INTO telebirr_transactions (tx_type, sender_name, amount, ref_no, raw_sms, status, category, balance, agent_id, recipient_account)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
            [txType, party, amount, ref, c.msg, status, category, balance, agentId, recipientAccount]
          );
        }
        if (result.rows.length === 0) return res.json({ status: 'Duplicate', bank: c.bank, type: txType, ref: ref || v2, agent: agent ? agent.name : 'Owner' });
        if (c.isCbe && !ref) {
          setTimeout(() => resolvePending().catch(() => {}), 3000);
          return res.json({ status: 'Saved', bank: c.bank, type: txType, amount, balance, party, recipient_account: recipientAccount, agent: agent ? agent.name : 'Owner', ref: null, resolving: true, v2 });
        }
        return res.json({ status: 'Saved', bank: c.bank, type: txType, category, ref, amount, balance, party, recipient_account: recipientAccount, agent: agent ? agent.name : 'Owner' });
      } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'Database_Error' });
      }
    }

    // 2. CBE manual FT / pending list / debug
    app.get('/api/cbe/resolve', async (req, res) => {
      if (!auth(req, res)) return;
      const m = String(req.query.v2 || '').match(/v2-[A-Za-z0-9_-]+/i);
      const ft = String(req.query.ft || '').trim().toUpperCase();
      if (!m) return res.json({ status: 'Missing_V2' });
      if (!/^FT[A-Z0-9]{8,15}$/.test(ft)) return res.json({ status: 'Invalid_FT' });
      try {
        const r = await pool.query('SELECT id FROM cbe_transactions WHERE v2_code=$1 AND ref_no IS NULL', [normV2(m[0])]);
        if (!r.rows.length) return res.json({ status: 'Not_Pending' });
        return res.json({ status: await settleFt(r.rows[0].id, ft), ref_no: ft });
      } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
    });

    app.get('/api/cbe/pending', async (req, res) => {
      if (!auth(req, res)) return;
      try {
        const r = await pool.query(
          `SELECT id, v2_code, amount, sender_name, COALESCE(resolve_attempts,0) AS attempts
           FROM cbe_transactions WHERE ref_no IS NULL ORDER BY id DESC LIMIT 50`
        );
        return res.json({ status: 'OK', count: r.rows.length, items: r.rows });
      } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
    });

    app.get('/api/cbe/debug', async (req, res) => {
      if (!auth(req, res)) return;
      const m = String(req.query.v2 || '').match(/v2-[A-Za-z0-9_-]+/i);
      if (!m) return res.json({ status: 'Missing_V2' });
      const out = [];
      for (const t of cbeTargets(m[0])) {
        try {
          const r = await fetchHttps(t.host, t.path, t.headers);
          const ft = r.body.match(/\b(FT[A-Z0-9]{8,15})\b/i);
          out.push({ target: t.name, http: r.status, bytes: r.body.length, ft: ft ? ft[1].toUpperCase() : null, body: r.body.replace(/\s+/g, ' ').slice(0, 400) });
        } catch (e) { out.push({ target: t.name, error: e.message }); }
      }
      return res.json({ status: 'OK', results: out });
    });

    // 3. VERIFY endpoint (accepts SECRET_TOKEN or VERIFY_TOKEN)
    app.get('/api/verify', async (req, res) => {
      if (!authVerify(req, res)) return;
      try {
        const username = String(req.query.username || req.query.claimed_by || '').trim().slice(0, 128);
        const out = await verifyPaymentDirect(
          req.query.ref,
          req.query.amount,
          req.query.sms || req.query.text,
          username ? { username } : null
        );
        return res.json(out);
      } catch (err) {
        console.error('sms /api/verify:', err);
        return res.status(500).json({ status: 'System_Busy' });
      }
    });

    // 3b. WITHDRAWAL VERIFY & PREVIEW (?name=&amount=&withdrawal_id= OR &ref=)
    const handleWithdrawalQuery = async (req, res, readOnly) => {
      if (!authVerify(req, res)) return;
      const ref = String(req.query.ref || '').trim().toUpperCase();
      const name = String(req.query.name || req.query.customer_name || req.query.customerName || '').trim();
      const withdrawalId = String(req.query.withdrawal_id || req.query.withdrawalId || req.query.txn_id || req.query.txnId || '').trim();
      const method = req.query.bank || req.query.method || '';
      const account = String(req.query.account || req.query.recipient_account || '').trim();
      const amtRaw = req.query.amount !== undefined ? parseFloat(req.query.amount) : NaN;
      if (!ref && !name && !account) {
        return res.status(400).json({ status: 'Missing_Query', message: 'Provide name, ref, or account' });
      }
      if (!ref && (isNaN(amtRaw) || amtRaw <= 0)) {
        return res.status(400).json({ status: 'Missing_Amount', message: 'Valid ETB amount is required for name/account matching' });
      }
      if (!readOnly && !withdrawalId) {
        return res.status(400).json({ status: 'Missing_Withdrawal_Id', message: 'withdrawal_id is required to verify and lock payout' });
      }
      try {
        const m = await matchWithdrawalSms({
          txnId: withdrawalId,
          method,
          amount: Number.isFinite(amtRaw) ? amtRaw : undefined,
          recipientAccount: account,
          customerName: name,
          ref,
          actor: withdrawalId || req.query.actor || 'VERIFY_API',
          readOnly
        });
        if (!m.matched) {
          return res.json({
            status: m.status || 'Not_Found',
            bank: m.bank || null,
            expected: m.expected,
            actual: m.actual,
            message: m.reason || 'No matching Sent_Locked payout found'
          });
        }
        return res.json({
          status: readOnly ? 'Found' : 'Verified',
          bank: m.bank,
          amount: m.amount,
          ref_no: m.ref,
          customer_name: m.party,
          recipient_account: m.recipientAccount || '',
          agent_id: m.agentId || null,
          agent: m.agentName || 'Owner',
          withdrawal_id: withdrawalId || null,
          match_mode: m.matchMode
        });
      } catch (err) {
        console.error('sms withdrawal verify:', err);
        return res.status(500).json({ status: 'System_Busy' });
      }
    };
    app.get('/api/verify-withdrawal', (req, res) => handleWithdrawalQuery(req, res, false));
    app.get('/api/check-withdrawal', (req, res) => handleWithdrawalQuery(req, res, true));

    // 4. READ-ONLY CHECK
    app.get('/api/check', async (req, res) => {
      if (!auth(req, res)) return;
      const inp = parseVerifyInput(req.query.ref, req.query.sms || req.query.text);
      if (!inp) return res.json({ status: 'Missing_Ref' });
      try {
        const t = await locate(inp);
        const selectSql = t.table === 'telebirr_transactions'
          ? 'SELECT * FROM telebirr_transactions WHERE ref_no = $1'
          : (t.col === 'ref_no'
              ? 'SELECT * FROM cbe_transactions WHERE ref_no = $1'
              : 'SELECT * FROM cbe_transactions WHERE v2_code = $1');
        const r = await pool.query(selectSql, [t.val]);
        if (!r.rows.length) return res.json({ status: 'Not_Found', bank: t.bank, looked_for: t.val });
        const x = r.rows[0];
        const out = {
          status: x.ref_no ? 'Found' : 'Found_FT_Pending',
          bank: t.bank,
          type: x.tx_type,
          amount: parseFloat(x.amount),
          ref_no: x.ref_no,
          party: x.sender_name,
          usage: x.status,
          category: x.category || null,
          balance: x.balance != null ? parseFloat(x.balance) : null,
          v2_code: x.v2_code || null,
          created_at: x.created_at || null,
          agent_id: x.agent_id || null
        };
        if (req.query.live && t.bank === 'CBE' && (x.v2_code || inp.type === 'v2')) {
          try {
            const tg = cbeTargets(x.v2_code || inp.value)[0];
            const j = JSON.parse((await fetchHttps(tg.host, tg.path, tg.headers)).body);
            out.cbe_live = {
              ft: j.id, amount: j.debitAmount, from: j.debitAccountNo, to: j.creditAccountNo, date: j.debitValueDate,
              amount_matches_db: Math.abs(parseFloat(j.debitAmount) - out.amount) < 0.001
            };
          } catch (e) { out.cbe_live = { error: e.message }; }
        }
        return res.json(out);
      } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
    });

    app.get('/api/recent', async (req, res) => {
      if (!auth(req, res)) return;
      const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      try {
        const cols = 'id, tx_type, amount, ref_no, sender_name, recipient_account, status, category, balance, agent_id, claimed_by_user_id, claimed_by_username, claimed_txn_id, created_at';
        const c = await pool.query(`SELECT ${cols}, v2_code, resolve_attempts FROM cbe_transactions ORDER BY id DESC LIMIT $1`, [n]);
        const t = await pool.query(`SELECT ${cols} FROM telebirr_transactions ORDER BY id DESC LIMIT $1`, [n]);
        return res.json({ status: 'OK', cbe: c.rows, telebirr: t.rows });
      } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
    });

    // 5. AGENTS REPORTS (?token=.. handles verify server report; without token falls through to public HuluBet cashier agents)
    const smsAgentsReportHandler = async (req, res) => {
      if (!auth(req, res)) return;
      try {
        const r = await pool.query(
          `SELECT a.id, a.name, a.active,
                  COALESCE(SUM(d.amount),0) AS total_in,
                  COUNT(d.tx_id) AS count_in,
                  COALESCE(SUM(d.amount) FILTER (WHERE (d.created_at AT TIME ZONE 'Africa/Addis_Ababa')::date = (NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date),0) AS today_in
           FROM sms_agents a LEFT JOIN agent_deposits d ON d.agent_id = a.id
           GROUP BY a.id ORDER BY a.id`
        );
        return res.json({ status: 'OK', agents: r.rows });
      } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
    };

    app.get('/api/sms/agents', smsAgentsReportHandler);
    app.get('/api/agents', (req, res, next) => {
      if (req.query.token !== undefined || req.headers['x-verify-token'] !== undefined) {
        return smsAgentsReportHandler(req, res);
      }
      return next();
    });

    app.get('/api/agent/deposits', async (req, res) => {
      if (!auth(req, res)) return;
      const id = parseInt(req.query.agent, 10);
      if (isNaN(id)) return res.json({ status: 'Missing_Agent' });
      const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const from = req.query.from || '1970-01-01';
      const to = req.query.to || '2999-12-31';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
        return res.status(400).json({ status: 'Invalid_Date' });
      }
      try {
        const r = await pool.query(
          `SELECT bank, tx_id, amount, ref_no, sender_name, recipient_account, balance, status, claimed_by_user_id, claimed_by_username, claimed_txn_id, created_at
           FROM agent_deposits
           WHERE agent_id = $1
             AND (created_at AT TIME ZONE 'Africa/Addis_Ababa')::date BETWEEN $2::date AND $3::date
           ORDER BY created_at DESC LIMIT $4`,
          [id, from, to, n]
        );
        const total = r.rows.reduce((s, x) => s + parseFloat(x.amount), 0);
        return res.json({ status: 'OK', agent: id, count: r.rows.length, total, items: r.rows });
      } catch (e) { console.error(e); return res.status(500).json({ status: 'Database_Error' }); }
    });

    // Admin management helpers for viewing webhook link & managing SMS forwarder agents
    if (admin && h) {
      app.get('/api/admin/sms-config', admin, h(async (req, res) => {
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const host = req.headers['x-forwarded-host'] || req.get('host');
        const base = `${proto}://${host}`;
        const t = getTokens();
        const agents = await pool.query('SELECT id, name, token, match_text, active, created_at FROM sms_agents ORDER BY id').catch(() => ({ rows: [] }));
        res.json({
          success: true,
          baseUrl: base,
          webhookBaseUrl: `${base}/webhook/sms`,
          webhookUrl: `${base}/webhook/sms?token=${t.secretToken}`,
          verifyUrl: `${base}/api/verify?token=${t.verifyToken}`,
          secretToken: t.secretToken,
          verifyToken: t.verifyToken,
          isEnvConfigured: t.isEnvConfigured,
          agents: agents.rows.map(a => ({ ...a, webhookUrl: `${base}/webhook/sms?token=${a.token}` }))
        });
      }));

      app.post('/api/admin/sms-agents', admin, h(async (req, res) => {
        const name = String(req.body?.name || '').trim().slice(0, 120);
        const matchText = String(req.body?.matchText || '').trim().slice(0, 255);
        const token = String(req.body?.token || '').trim().slice(0, 128) || crypto.randomBytes(16).toString('hex');
        if (!name) return res.status(400).json({ success: false, message: 'Agent name required' });
        const r = await pool.query(
          `INSERT INTO sms_agents (name, token, match_text, active) VALUES ($1,$2,$3,TRUE) RETURNING id, name, token, match_text, active`,
          [name, token, matchText]
        );
        res.json({ success: true, agent: r.rows[0] });
      }));

      app.post('/api/admin/sms-agents/toggle', admin, h(async (req, res) => {
        const id = parseInt(req.body?.id, 10);
        if (isNaN(id)) return res.status(400).json({ success: false, message: 'Valid agent id required' });
        const r = await pool.query('UPDATE sms_agents SET active = NOT active WHERE id=$1 RETURNING id, name, active', [id]);
        if (!r.rowCount) return res.status(404).json({ success: false, message: 'SMS agent not found' });
        res.json({ success: true, agent: r.rows[0] });
      }));
    }
  }

  return {
    ensureSchemaAndToken,
    startCbeBackgroundResolver,
    mountRoutes,
    verifyPaymentDirect,
    matchWithdrawalSms,
    getTokens
  };
}

module.exports = {
  createSmsVerifyService,
  resolveFtNumber,
  cbeTargets,
  parsers: {
    classify,
    extractAmount,
    extractBalance,
    extractTelebirrRef,
    extractParty,
    extractRecipientAccount,
    accountLastDigitsMatch,
    normalizePersonName,
    levenshtein,
    fuzzyNameMatch,
    detectCategory,
    extractV2Code,
    extractDirectFt,
    parseVerifyInput,
    normV2
  }
};
