'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { parsers } = require('./sms-verify-server');

test('SMS parsers accurately extract Telebirr EN/AM and CBE fields', () => {
  // 1. Telebirr English incoming
  const tbEn = 'Dear Abebe, You have received ETB 250.50 from Kebede Tesfaye (0911223344) on 23/11/2026. Your transaction number is TX98765432AB. Your current balance is ETB 1,450.75.';
  const c1 = parsers.classify(tbEn, '127');
  assert.equal(c1.bank, 'Telebirr');
  assert.equal(c1.isIncoming, true);
  assert.equal(c1.isOutgoing, false);
  assert.equal(parsers.extractAmount(tbEn), 250.50);
  assert.equal(parsers.extractBalance(tbEn), 1450.75);
  assert.equal(parsers.extractTelebirrRef(tbEn), 'TX98765432AB');
  assert.equal(parsers.detectCategory(tbEn, true), 'Received');

  // 2. Telebirr Amharic incoming & outgoing
  const tbAmIn = 'ውድ ደንበኛ ከ DAWIT ALEMU (0911998877) 500 ብር ተቀብለዋል። የግብይት ቁጥርዎ CDE4567890FG ነው። ቀሪ ሂሳብ 2500 ብር';
  const c2 = parsers.classify(tbAmIn, 'telebirr');
  assert.equal(c2.bank, 'Telebirr');
  assert.equal(c2.isIncoming, true);
  assert.equal(parsers.extractAmount(tbAmIn), 500);
  assert.equal(parsers.extractBalance(tbAmIn), 2500);
  assert.equal(parsers.extractTelebirrRef(tbAmIn), 'CDE4567890FG');

  const tbAmOut = 'ለ ETHIO TELECOM 100.00 ብር ከፍለዋል። የግብይት ቁጥርዎ OUT12345678 ነው። ቀሪ ሂሳብ 900.00 ብር';
  const c3 = parsers.classify(tbAmOut, '127');
  assert.equal(c3.isIncoming, false);
  assert.equal(c3.isOutgoing, true);
  assert.equal(parsers.detectCategory(tbAmOut, false), 'Payment');

  // 3. CBE FT & v2 receipt link
  const cbeFt = 'Dear Customer, Your Account 1000123456789 has been credited with ETB 1,200.00 from MELAKU TADESSE (FT26327XYZ99). Current balance is ETB 9,000.00.';
  const c4 = parsers.classify(cbeFt, 'CBE');
  assert.equal(c4.bank, 'CBE');
  assert.equal(c4.isIncoming, true);
  assert.equal(parsers.extractAmount(cbeFt), 1200);
  assert.equal(parsers.extractDirectFt(cbeFt), 'FT26327XYZ99');

  const cbeV2 = 'Your account 10001*789 has been credited with ETB 350.00. https://mb.cbe.com.et/v2-AbC123XyZ789 Thank you for banking with CBE';
  assert.equal(parsers.extractV2Code(cbeV2), 'v2-AbC123XyZ789');

  // 4. parseVerifyInput variants
  assert.deepEqual(parsers.parseVerifyInput('FT26327XYZ99', ''), { type: 'ft', value: 'FT26327XYZ99', amount: 0 });
  assert.deepEqual(parsers.parseVerifyInput('https://mb.cbe.com.et/v2-AbC123', ''), { type: 'v2', value: 'v2-AbC123', amount: 0 });
  assert.deepEqual(parsers.parseVerifyInput('https://transactioninfo.ethiotelecom.et/receipt/TX98765432AB', ''), { type: 'tb', value: 'TX98765432AB', amount: 0 });
  assert.equal(parsers.parseVerifyInput('', tbEn).value, 'TX98765432AB');
  assert.equal(parsers.parseVerifyInput('', tbEn).amount, 250.5);
});

test('SMS Verification Server, Direct Deposit Claim, and Interactive Step Games (no auto-cashout)', async (t) => {
  const PORT = 3201;
  const BASE = `http://127.0.0.1:${PORT}`;
  const PIN = 'verifypin99';
  const SECRET = 'test_webhook_secret_token_abc';
  const VERIFY_TOK = 'test_verify_token_xyz';

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: '',
      BOT_TOKEN: '',
      ADMIN_PIN: PIN,
      SECRET_TOKEN: SECRET,
      VERIFY_TOKEN: VERIFY_TOK,
      USE_EXTERNAL_VERIFI: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(() => {
    try { child.kill('SIGTERM'); } catch (_) {}
  });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/ping`);
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  assert.equal(ready, true, 'Server failed to boot on port 3201');

  const hU = { 'Content-Type': 'application/json', 'x-telegram-init-data': 'demo_session' };
  const hA = { 'Content-Type': 'application/json', 'x-admin-token': PIN };
  const reqJson = async (p, opts = {}) => {
    const r = await fetch(`${BASE}${p}`, opts);
    return { status: r.status, body: await r.json() };
  };

  // Init user
  const init = await reqJson('/api/user/init', { headers: hU });
  assert.equal(init.status, 200);
  const startBal = init.body.balance;

  // 1. Admin SMS config & agent creation
  const cfg = await reqJson('/api/admin/sms-config', { headers: hA });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.secretToken, SECRET);
  assert.equal(cfg.body.verifyToken, VERIFY_TOK);

  const ag = await reqJson('/api/admin/sms-agents', {
    method: 'POST', headers: hA,
    body: JSON.stringify({ name: 'Bole Agent', matchText: 'Bole', token: 'agent_tok_1' })
  });
  assert.equal(ag.status, 200);
  assert.equal(ag.body.agent.name, 'Bole Agent');

  // 2. Unauthorized SMS webhook rejected with 401
  const badHook = await reqJson(`/webhook/sms?token=wrong&sender=127&message=hello`);
  assert.equal(badHook.status, 401);

  // 3. Collect Telebirr incoming SMS via GET & CBE via POST
  const tbMsg = encodeURIComponent('You have received ETB 250.00 from Dawit (Bole) on 23/11/2026. Your transaction number is TB250TEST99. Your current balance is ETB 1250.00');
  const getHook = await reqJson(`/webhook/sms?token=${SECRET}&sender=127&message=${tbMsg}`);
  assert.equal(getHook.status, 200);
  assert.equal(getHook.body.type, 'Received');
  assert.equal(getHook.body.amount, 250);

  const cbeHook = await reqJson(`/webhook/sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-token': SECRET },
    body: JSON.stringify({
      sender: 'CBE',
      message: 'Dear customer, Your account 1000123456 has been credited with ETB 400.00 from Yared. https://mb.cbe.com.et/v2-TESTCODE12 FT26327CBR44 Thank you for banking with CBE'
    })
  });
  assert.equal(cbeHook.status, 200);
  assert.equal(cbeHook.body.status, 'Saved');
  assert.equal(cbeHook.body.bank, 'CBE');
  assert.equal(cbeHook.body.type, 'Received');
  assert.equal(cbeHook.body.ref, 'FT26327CBR44');

  // 4. Verify endpoints: /api/recent, /api/check, /api/sms/agents, /api/agents?token=..., /api/agent/deposits, /api/verify
  const scopedReject = await reqJson(`/api/recent?token=${VERIFY_TOK}&limit=10`);
  assert.equal(scopedReject.status, 401);

  const rec = await reqJson(`/api/recent?token=${SECRET}&limit=10`);
  assert.equal(rec.status, 200);
  assert.equal(rec.body.status, 'OK');
  assert.ok(rec.body.cbe.length >= 1 && rec.body.telebirr.length >= 1);

  const chk = await reqJson(`/api/check?token=${SECRET}&ref=TB250TEST99`);
  assert.equal(chk.status, 200);
  assert.equal(chk.body.status, 'Found');
  assert.equal(chk.body.usage, 'Unused');
  assert.equal(chk.body.amount, 250);

  const agList = await reqJson(`/api/sms/agents?token=${SECRET}`);
  assert.equal(agList.status, 200);
  assert.ok(agList.body.agents.some(a => a.name === 'Bole Agent'));

  const agQuery = await reqJson(`/api/agents?token=${SECRET}`);
  assert.equal(agQuery.status, 200);
  assert.ok(Array.isArray(agQuery.body.agents));

  const agDep = await reqJson(`/api/agent/deposits?token=${SECRET}&agent=${ag.body.agent.id}`);
  assert.equal(agDep.status, 200);
  assert.equal(agDep.body.status, 'OK');
  assert.ok(agDep.body.total >= 250);

  // Scoped VERIFY_TOKEN works on /api/verify for CBE FT
  const verCbe = await reqJson(`/api/verify?token=${VERIFY_TOK}&ref=FT26327CBR44&amount=400`);
  assert.equal(verCbe.status, 200);
  assert.equal(verCbe.body.status, 'Verified');
  assert.equal(verCbe.body.bank, 'CBE');

  // 5. HuluBet direct deposit verification claim + duplicate replay lock + wrong amount check
  const wrongAmt = await reqJson('/api/cashier/verify-deposit', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ amount: 300, ref: 'TB250TEST99', method: 'Telebirr' })
  });
  assert.equal(wrongAmt.status, 400);

  const okDep = await reqJson('/api/cashier/verify-deposit', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ amount: 250, ref: 'TB250TEST99', method: 'Telebirr' })
  });
  assert.equal(okDep.status, 200);
  assert.equal(okDep.body.newBalance, startBal + 250);

  const replayDep = await reqJson('/api/cashier/verify-deposit', {
    method: 'POST', headers: hU,
    body: JSON.stringify({ amount: 250, ref: 'TB250TEST99', method: 'Telebirr' })
  });
  assert.equal(replayDep.status, 409);

  // 6. Interactive step games: verify NO automatic cashout on SAFE & manual cashout works
  for (const gameSlug of ['chicken-road', 'roasted-chicken', 'mega-block']) {
    let settled = false;
    for (let attempt = 0; attempt < 8 && !settled; attempt++) {
      const s = await reqJson(`/api/games/${gameSlug}/start`, {
        method: 'POST', headers: hU,
        body: JSON.stringify({ betAmount: 10, difficulty: 'easy' })
      });
      assert.equal(s.status, 200);
      assert.ok(s.body.betId);

      // Cannot cash out at step 0
      const earlyCash = await reqJson(`/api/games/${gameSlug}/cashout`, {
        method: 'POST', headers: hU,
        body: JSON.stringify({ betId: s.body.betId })
      });
      assert.equal(earlyCash.status, 400);

      // Cannot start second round while IN_FLIGHT
      const dupStart = await reqJson(`/api/games/${gameSlug}/start`, {
        method: 'POST', headers: hU,
        body: JSON.stringify({ betAmount: 10, difficulty: 'easy' })
      });
      assert.equal(dupStart.status, 400);

      const st = await reqJson(`/api/games/${gameSlug}/step`, {
        method: 'POST', headers: hU,
        body: JSON.stringify({ betId: s.body.betId })
      });
      assert.equal(st.status, 200);

      if (st.body.state === 'SAFE') {
        // Confirm round is STILL active/IN_FLIGHT (NOT auto-cashed out)
        const act = await reqJson(`/api/games/${gameSlug}/active`, { headers: hU });
        assert.equal(act.status, 200);
        assert.ok(act.body.active, `${gameSlug} unexpectedly cleared active round on SAFE!`);
        assert.equal(act.body.active.step, 1);

        const co = await reqJson(`/api/games/${gameSlug}/cashout`, {
          method: 'POST', headers: hU,
          body: JSON.stringify({ betId: s.body.betId })
        });
        assert.equal(co.status, 200);
        assert.ok(co.body.payout > 10);
        settled = true;
      }
    }
    assert.equal(settled, true, `Expected at least one SAFE step + manual cashout for ${gameSlug}`);
  }
});

test('External verify server mode (VERIFI_URL + VERIFI_TOKEN) and admin gateway checks', async (t) => {
  const http = require('node:http');
  const EXT_TOK = 'ext_verify_secret_123';
  let extRequests = [];
  const extServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    extRequests.push({ path: u.pathname, token: u.searchParams.get('token'), ref: u.searchParams.get('ref'), amount: u.searchParams.get('amount') });
    if (u.searchParams.get('token') !== EXT_TOK) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'Unauthorized' }));
    }
    const ref = u.searchParams.get('ref');
    if (ref === 'EXTVERIFIED1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'Verified', bank: 'Telebirr', amount: 150, ref_no: ref }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'Not_Found' }));
  });
  await new Promise(resolve => extServer.listen(0, '127.0.0.1', resolve));
  const extPort = extServer.address().port;

  const PORT = 3202;
  const BASE = `http://127.0.0.1:${PORT}`;
  const PIN = 'extpin9876';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: '',
      BOT_TOKEN: '',
      ADMIN_PIN: PIN,
      VERIFI_TOKEN: EXT_TOK,
      VERIFI_URL: `http://127.0.0.1:${extPort}/api/verify`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(() => {
    try { child.kill('SIGTERM'); } catch (_) {}
    try { extServer.close(); } catch (_) {}
  });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/ping`);
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  assert.equal(ready, true, 'External-verify test server failed to boot');

  const hU = { 'Content-Type': 'application/json', 'x-telegram-init-data': 'demo_session' };
  const hA = { 'Content-Type': 'application/json', 'x-admin-token': PIN };
  await fetch(`${BASE}/api/user/init`, { headers: hU });

  // Admin routes (/admin, /betadmin, /betadmin.html) serve HTML
  for (const p of ['/admin', '/betadmin', '/betadmin.html']) {
    const r = await fetch(`${BASE}${p}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Hulu Bet Admin/);
  }

  // Dashboard reports safe system config without leaking VERIFI_TOKEN
  const dash = await (await fetch(`${BASE}/api/admin/master-dashboard`, { headers: hA })).json();
  assert.equal(dash.success, true);
  assert.equal(dash.system.verifyMode, 'External Verify Server');
  assert.equal(dash.system.verifiTokenSet, true);
  assert.equal(dash.system.customAdminPin, true);
  assert.equal(JSON.stringify(dash).includes(EXT_TOK), false);

  // Admin test-verify hits external endpoint
  const tv = await (await fetch(`${BASE}/api/admin/test-verify`, { method: 'POST', headers: hA, body: '{}' })).json();
  assert.equal(tv.success, true);
  assert.equal(tv.mode, 'external');
  assert.equal(tv.gatewayStatus, 'Not_Found');

  // Verify deposit delegates to external server and credits user
  const dep = await (await fetch(`${BASE}/api/cashier/verify-deposit`, {
    method: 'POST', headers: hU,
    body: JSON.stringify({ amount: 150, ref: 'EXTVERIFIED1', method: 'Telebirr' })
  })).json();
  assert.equal(dep.success, true);
  assert.equal(dep.credited, 150);
  assert.ok(extRequests.some(r => r.ref === 'EXTVERIFIED1' && r.token === EXT_TOK));
});

