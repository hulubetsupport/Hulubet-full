# Hulu Bet – Game Integration Spec (give this file to any AI / developer)

Goal: build or fix a casino game page (single `.html` file, hosted on GitHub Pages) that works with the Hulu Bet server.
**Golden rule: the server decides every result and every payout. The game page only animates and asks.**
Reference implementation: `jetx.html` (crash game). Server: `server.js`. Server URL: `https://hulubet-server.onrender.com`.

---

## 1. How a game page runs

- The lobby (`home.html`) loads the game in an `<iframe>` from `https://hulubetsupport.github.io/<game>/`.
- The game NEVER gets user id or balance from the URL. It receives the session by `postMessage` from the lobby.
- Every API call must send the header `x-telegram-init-data: <initData>` (proves the Telegram user). No header = `401`.

### Mandatory boilerplate (paste at the top of every game script)

```js
const API = "https://hulubet-server.onrender.com";
let INIT_DATA = "", serverBalance = 0, ready = false;

async function api(path, opts = {}) {
  try {
    const r = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-telegram-init-data': INIT_DATA } });
    return await r.json();
  } catch (e) { return { success: false, message: 'Connection problem' }; }
}
const postParent = m => { try { parent.postMessage(m, '*'); } catch (e) {} };

addEventListener('message', e => {
  if (e.source !== parent) return;
  const d = e.data || {};
  if (d.type === 'INIT' && d.initData) { INIT_DATA = d.initData; ready = true; refreshBalance(); }
  if (d.type === 'UPDATE_BALANCE') refreshBalance();
});
postParent({ type: 'GAME_READY' });            // lobby answers with INIT

async function refreshBalance() {
  const d = await api('/api/user/init');       // authoritative balance
  if (d.success) { serverBalance = d.balance; showBalance(); }
}
function showBalance() { /* update UI */ postParent({ type: 'BALANCE_UPDATE', newBalance: serverBalance }); }
```

Messages the game sends to the lobby: `GAME_READY`, `BALANCE_UPDATE {newBalance}`, `BET_STARTED` (round running, lobby warns before leaving), `BET_ENDED`, `OPEN_DEPOSIT` (balance too low).

---

## 2. Global rules

| Rule | Value |
|---|---|
| Min / max bet | 1 – 1000 ETB |
| Max payout per bet | 20,000 ETB |
| Target RTP | set by admin (default 85%); never hard-code odds in the client |
| Errors | JSON `{success:false, message}`. `401` session expired, `403` account restricted, `429` too many requests. Show `message` in a toast. |

Client must: disable the bet button while a request is in flight; show `serverBalance` (never compute balance locally); never store balance/user id in localStorage; never trust the URL; never show fake players, fake wins, fake history, or fake jackpots.

---

## 3. Game type A – Crash (Aviator, JetX)

Server-authoritative. The crash point is **secret** until the round is settled.

### Endpoints
```
POST /api/crash/bet      { gameName:"Aviator"|"JetX", bets:[{amount, auto|null}, ...1 or 2 bets] }
  -> { success, roundId, commit, betIds:[...], newBalance, growth:{a,b,c} }
POST /api/crash/cashout  { betId, clientMult }          // clientMult = multiplier shown on screen at click
  -> { success, state:"WON"|"CRASHED", multiplier, payout, newBalance, crashPoint?, serverSeed?, commit? }
GET  /api/crash/status?betId=...   -> { success, state:"FLYING" } or same object as cashout
GET  /api/public/feed?game=JetX    -> { wins:[{user,game,win,mult}], crashes:[15 real recent crash points] }
```
- `auto` = auto-cash-out multiplier (>=1.01) or `null`. The SERVER executes it, even if the player closes the app.
- Balance is deducted when `/crash/bet` succeeds. Winnings are credited by the server on WON.
- `crashPoint` appears in a response only when every bet of that round is settled (never use it to cash out the sibling bet).

### Multiplier curve (client MUST use exactly this, with `growth` from the bet response)
```js
mult = t => Math.floor((1 + a*t + b*Math.pow(t, c)) * 100) / 100;   // t = seconds since bet response arrived
// defaults: a=0.065, b=0.035, c=1.48
```
Aviator must use the same curve (it may change visuals, not the math), otherwise displayed and paid multipliers differ.

### Flow
1. Waiting phase: player queues bets locally (reserve the amount in the UI only, no request yet).
2. Launch: call `/crash/bet` with the queued bets. On failure: show message, reset panels.
3. Fly: start timer, animate with `mult(t)`. Poll `/crash/status` every 250 ms for each open bet.
4. Player taps Collect: `POST /crash/cashout {betId, clientMult: currentMultiplier}`. Show the returned `payout`.
5. `state:"CRASHED"` from any call -> stop animation, show `crashPoint`. If `crashPoint` arrives with a WON response, keep flying until `mult(t) >= crashPoint`, then show the crash.
6. If no bet is queued when a round should start, do NOT animate a fake round; just wait.

### Math (server side, for reference)
`crash = max(1, floor(100 * RTP / (1 - u)) / 100)`, u uniform in [0,1) from HMAC-SHA256(serverSeed, roundId). `P(crash >= x) = RTP / x`, so every cash-out strategy has expected return = RTP. Round is provably fair: `commit = sha256(serverSeed)` is returned at bet time, `serverSeed` is revealed after settlement.

---

## 4. Game type B – Keno (KenoFast)

```
POST /api/bet/play  { gameName:"KenoFast", betAmount, clientData:{ picks:[1..10 unique ints from 1..80] } }
  -> { success, betId, multiplier, payout, isWin, newBalance,
       visualOutcome:{ drawnNumbers:[20 ints, in draw order], hits, picks } }
GET  /api/keno/paytable -> { paytable:{ "1":[m0,m1], "2":[m0,m1,m2], ... "10":[m0..m10] } }
```
- Real draw: 20 of 80 numbers. `hits` = picks found in `drawnNumbers`.
- Payout = bet × `paytable[picks.length][hits]`. **Show this paytable in the UI, loaded from the endpoint** (it changes with the RTP setting). Never hard-code multipliers.
- Animate `drawnNumbers` one by one in the given order, highlight matches, then show payout. The result is already final when the response arrives.

---

## 5. Game type C – Instant games (ChickenRoad2, Slot777, AviaMasters)

```
POST /api/bet/play  { gameName:"ChickenRoad2"|"Slot777"|"AviaMasters", betAmount, clientData:{} }
  -> { success, betId, multiplier, payout, isWin, newBalance, visualOutcome }
```
`multiplier` 0 = loss (bet is lost, `payout` 0). The animation must be built to MATCH the result:

| Game | visualOutcome | How to animate |
|---|---|---|
| ChickenRoad2 | `{ maxSafeStep }` | chicken crosses `maxSafeStep` lanes safely; on loss it is hit on the next lane; on win it reaches the end and pays `multiplier` |
| Slot777 | `{ reels:[3 symbol keys], payline, colMult }` | keys are `lemon`, `orange`, `cherry`, `bell`, `seven`; draw each key as your own SVG icon and stop the reels on exactly these symbols; `payline:"NONE"` = no win |
| AviaMasters | `{ safeLanding:bool, targetMultiplier }` | plane lands on the ship/ground if `safeLanding`, otherwise falls into the ocean |

Odds (server): 70% loss, 20% small win (~1.2–2.0x), 8% medium (~2.2–5.0x), 2% big (~6–20x), all scaled so the long-run RTP equals the admin RTP.

---

## 6. UI checklist for every game
- **No emoji anywhere** (UI text, toasts, buttons, reels, messages). Icons are inline SVG only (stroke style, `currentColor`), never emoji characters or emoji-like symbols.
- Balance shown top-right, updated from `newBalance` of every response.
- Bet input with min 1 / max 1000, quick chips, +/- buttons.
- Loading state on the bet button; error toast with the server `message`.
- "Insufficient balance" -> `postParent({type:'OPEN_DEPOSIT'})`.
- Mobile first (max-width 480px), no horizontal scroll, works inside Telegram WebView.
- Sounds start only after a user tap (browser autoplay rules).
- No external libraries that can fail to load; single HTML file.

## 7. Test checklist
1. Open the game outside Telegram -> shows "open from the app", nothing crashes.
2. Bet, win, lose: balance in the game == balance in the lobby == balance after a page reload.
3. Kill the network mid-round: no double charge, no free win; reopening shows the settled result.
4. Rapid double tap on Bet: only one bet is placed.
5. Very small (1) and max (1000) bets work; 1001 shows the server message.

## 8. Prompt to give another AI
> Build `<GAME NAME>` as a single mobile-first HTML file for Hulu Bet. Follow `HULU_GAMES_SPEC.md` exactly: use the mandatory boilerplate, call only the endpoints listed for this game type, never compute results or balances on the client, and animate the `visualOutcome` returned by the server. Copy the structure of `jetx.html` for session handling, error toasts and balance updates. Return the complete file.

---

## 9. Contracts of the additional games (all use the same session boilerplate and `x-telegram-init-data` header)

| Game | Request | Reply (`visualOutcome`) |
|---|---|---|
| **Slot777** `POST /api/bet/play` `{gameName:"Slot777", betAmount}` | none | `{reels:[3 ids], colMult, winType:"NONE"/"PAIR"/"TRIPLE", winReels:[indexes]}`. Ids: `77 DOLLAR BELL MELON MANY_GRAPES PLUM LEMON ORANGE CHERRY`. Paytable: `GET /api/slot/paytable`. Show it from the server; never hard-code pays. |
| **PlinkoX** `POST /api/bet/play` `{gameName:"PlinkoX", betAmount: total, clientData:{risk:"low"|"medium"|"high", ballCount:1|5|10|25}}` | per-ball `{path:[16 x 0/1], bucket, mult, payout}` | `{rows:16, risk, unitBet, balls:[...]}`. Animate each ball along its `path`. Tables: `GET /api/plinko/paytable`. |
| **Roulette** `POST /api/bet/play` `{gameName:"Roulette", betAmount: total, clientData:{bets:[{type, amount}]}}` | types `num-0..36`, `col-1..3`, `dozen-1..3`, `low high even odd red black` | `{winningNumber, color, parts:[{type,amount,payout}]}`. European wheel, standard payouts, RTP 97.3%. |
| **AviaMasters** `POST /api/bet/play` `{gameName:"AviaMasters", betAmount}` | none | `{safeLanding, finalMultiplier, items:[6 x {type:"number"/"mult"/"rocket", val}]}`. Live multiplier starts at 1: number `+= val*0.2`, mult `*= val`, rocket `/= 2` (min 0.1). If `safeLanding` the payout is `bet * finalMultiplier`. |
| **ChickenRoad2** (rounds) | `POST /api/chicken/start {difficulty,betAmount}` -> `{betId,mults,newBalance}`; `POST /api/chicken/step {betId}` -> `{state:"SAFE"/"HIT"/"GOAL", step, multiplier, payout, newBalance}`; `POST /api/chicken/cashout {betId}`; `GET /api/chicken/active` to resume | The server hides where the traffic hits until you step there. Never credit balance on the client. |
| **Aviator** | same crash API as JetX (section 3) | |
| **KenoFast** | section 4 | |

Rules for every game: the result is final when the reply arrives; show the stake taken until the animation ends, then the real balance; no invented players, rounds, counters or history.
