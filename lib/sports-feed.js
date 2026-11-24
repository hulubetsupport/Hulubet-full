'use strict';

/**
 * Pure parser and adapter for live sports APIs:
 * - The Odds API v4 (api.the-odds-api.com — free tier 500 credits/mo via ?apiKey=...)
 * - ESPN Public Scoreboard JSON (no API key required)
 * - TheSportsDB v1 JSON (free tier key "3" or custom)
 * - Football-Data.org v4 JSON (free tier token via X-Auth-Token)
 * - API-Football v3 JSON (free tier key via x-apisports-key)
 */

function inferSportFromUrl(url = '') {
  const s = String(url).toLowerCase();
  if (s.includes('basketball') || s.includes('/nba')) return 'Basketball';
  if (s.includes('boxing') || s.includes('ufc') || s.includes('mma')) return 'Boxing';
  return 'Soccer';
}

function defaultMarketsForSport(sport, hs, as) {
  const diff = Number(hs || 0) - Number(as || 0);
  const total = Number(hs || 0) + Number(as || 0);
  if (sport === 'Basketball') {
    const hOdd = Math.max(1.25, Math.min(4.2, Number((1.9 - diff * 0.04).toFixed(2))));
    const aOdd = Math.max(1.25, Math.min(4.2, Number((1.9 + diff * 0.04).toFixed(2))));
    return [
      { key: '1', label: '1 (Home)', odds: hOdd },
      { key: 'X', label: 'X (Draw)', odds: 9.5 },
      { key: '2', label: '2 (Away)', odds: aOdd }
    ];
  }
  const hOdd = Math.max(1.3, Math.min(5.2, Number((2.25 - diff * 0.35).toFixed(2))));
  const xOdd = Math.max(2.1, Math.min(4.8, Number((3.15 + Math.abs(diff) * 0.3).toFixed(2))));
  const aOdd = Math.max(1.3, Math.min(5.2, Number((2.85 + diff * 0.35).toFixed(2))));
  const o25 = Math.max(1.25, Math.min(3.5, Number((total >= 3 ? 1.05 : (2.05 - total * 0.25)).toFixed(2))));
  const u25 = total >= 3 ? 12.0 : Math.max(1.3, Math.min(3.8, Number((1.75 + total * 0.45).toFixed(2))));
  return [
    { key: '1', label: '1 (Home)', odds: hOdd },
    { key: 'X', label: 'X (Draw)', odds: xOdd },
    { key: '2', label: '2 (Away)', odds: aOdd },
    { key: 'O2.5', label: 'Over 2.5', odds: o25 },
    { key: 'U2.5', label: 'Under 2.5', odds: u25 }
  ];
}

function normStatus(raw) {
  const s = String(raw || '').toUpperCase();
  if (/^(FT|FINAL|FINISHED|COMPLETE|COMPLETED|AET|PEN|POST)$/.test(s) || s.includes('FULL')) return 'FT';
  return 'LIVE';
}

function isOddsApiUrl(url = '') {
  return String(url || '').toLowerCase().includes('the-odds-api.com');
}

function sanitizeUrlForLog(url = '') {
  try {
    const u = new URL(String(url));
    if (u.searchParams.has('apiKey')) u.searchParams.set('apiKey', '***');
    return u.toString();
  } catch (_) {
    return String(url || '').replace(/apiKey=[^&]+/gi, 'apiKey=***');
  }
}

function buildFeedRequestUrl(rawUrl, apiKey = '') {
  const cleanUrl = String(rawUrl || '').trim();
  const key = String(apiKey || '').trim();
  let u;
  try {
    u = new URL(cleanUrl);
  } catch (_) {
    return cleanUrl;
  }

  if (isOddsApiUrl(u.hostname)) {
    const pathLower = u.pathname.toLowerCase().replace(/\/+$/, '');
    if (!pathLower || pathLower === '/sport' || pathLower === '/sports' || pathLower === '/v4/sports') {
      u.pathname = '/v4/sports/upcoming/odds/';
    }
    if (u.pathname.toLowerCase().includes('/odds')) {
      if (!u.searchParams.get('regions')) u.searchParams.set('regions', 'eu');
      if (!u.searchParams.get('markets')) u.searchParams.set('markets', 'h2h');
      if (!u.searchParams.get('oddsFormat')) u.searchParams.set('oddsFormat', 'decimal');
    }
    if (key && !u.searchParams.get('apiKey')) {
      u.searchParams.set('apiKey', key);
    }
  }
  return u.toString();
}

function buildFeedRequestHeaders(url, apiKey = '') {
  const headers = { 'Accept': 'application/json', 'User-Agent': 'HuluBetSportsFeed/1.0' };
  const key = String(apiKey || '').trim();
  const u = String(url || '').toLowerCase();
  if (key && !isOddsApiUrl(u)) {
    if (u.includes('api-sports.io') || u.includes('api-football')) headers['x-apisports-key'] = key;
    else if (u.includes('football-data.org')) headers['X-Auth-Token'] = key;
    else headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
}

function clampOdd(val, fallback = 1.9) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 1.01) return fallback;
  return Number(Math.max(1.05, Math.min(25, n)).toFixed(2));
}

function parseOddsApiEvents(arr) {
  const out = [];
  for (const item of arr.slice(0, 14)) {
    if (!item || !item.home_team || !item.away_team) continue;
    const sk = String(item.sport_key || item.sport_title || '').toLowerCase();
    const sport = (sk.includes('basketball') || sk.includes('nba'))
      ? 'Basketball'
      : ((sk.includes('boxing') || sk.includes('mma')) ? 'Boxing' : 'Soccer');

    let hs = 0;
    let as = 0;
    if (Array.isArray(item.scores)) {
      const hObj = item.scores.find(s => s.name === item.home_team);
      const aObj = item.scores.find(s => s.name === item.away_team);
      hs = Math.max(0, parseInt(hObj?.score ?? '0', 10) || 0);
      as = Math.max(0, parseInt(aObj?.score ?? '0', 10) || 0);
    }

    const completed = Boolean(item.completed);
    const status = completed ? 'FT' : 'LIVE';
    const startMs = item.commence_time ? Date.parse(item.commence_time) : NaN;
    const started = Number.isFinite(startMs) ? startMs <= Date.now() : true;
    let minute = 'LIVE';
    if (completed) {
      minute = 'FT';
    } else if (!started && Number.isFinite(startMs)) {
      minute = new Date(startMs).toISOString().slice(11, 16) + ' UTC';
    } else if (Array.isArray(item.scores) && item.scores.length) {
      minute = 'LIVE';
    }

    const defaults = defaultMarketsForSport(sport, hs, as);
    let hOdd = defaults.find(m => m.key === '1')?.odds || 2.1;
    let xOdd = defaults.find(m => m.key === 'X')?.odds || 3.2;
    let aOdd = defaults.find(m => m.key === '2')?.odds || 2.9;
    let o25 = defaults.find(m => m.key === 'O2.5')?.odds;
    let u25 = defaults.find(m => m.key === 'U2.5')?.odds;

    const bms = Array.isArray(item.bookmakers) ? item.bookmakers : [];
    for (const bm of bms) {
      const mkts = Array.isArray(bm.markets) ? bm.markets : [];
      const h2h = mkts.find(m => m.key === 'h2h');
      if (h2h && Array.isArray(h2h.outcomes)) {
        const oh = h2h.outcomes.find(o => o.name === item.home_team);
        const oa = h2h.outcomes.find(o => o.name === item.away_team);
        const ox = h2h.outcomes.find(o => /draw/i.test(String(o.name || '')));
        if (oh) hOdd = clampOdd(oh.price, hOdd);
        if (oa) aOdd = clampOdd(oa.price, aOdd);
        if (ox) xOdd = clampOdd(ox.price, xOdd);
      }
      const tot = mkts.find(m => m.key === 'totals');
      if (tot && Array.isArray(tot.outcomes)) {
        const oo = tot.outcomes.find(o => /^over/i.test(String(o.name || '')) && (o.point == null || Number(o.point) === 2.5))
          || tot.outcomes.find(o => /^over/i.test(String(o.name || '')));
        const ou = tot.outcomes.find(o => /^under/i.test(String(o.name || '')) && (o.point == null || Number(o.point) === 2.5))
          || tot.outcomes.find(o => /^under/i.test(String(o.name || '')));
        if (oo && o25 != null) o25 = clampOdd(oo.price, o25);
        if (ou && u25 != null) u25 = clampOdd(ou.price, u25);
      }
      if (h2h) break;
    }

    const markets = [
      { key: '1', label: '1 (Home)', odds: hOdd },
      { key: 'X', label: 'X (Draw)', odds: xOdd },
      { key: '2', label: '2 (Away)', odds: aOdd }
    ];
    if (sport === 'Soccer' && o25 != null && u25 != null) {
      markets.push({ key: 'O2.5', label: 'Over 2.5', odds: o25 });
      markets.push({ key: 'U2.5', label: 'Under 2.5', odds: u25 });
    }

    out.push({
      id: `EXT-ODDS-${String(item.id || out.length + 1).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`,
      sport,
      league: String(item.sport_title || item.sport_key || `${sport} Live`).slice(0, 40),
      home: String(item.home_team).slice(0, 36),
      away: String(item.away_team).slice(0, 36),
      homeScore: hs,
      awayScore: as,
      score: `${hs} - ${as}`,
      minute: String(minute).slice(0, 14),
      progress: completed ? 1 : (started ? 0.5 : 0.1),
      status,
      markets
    });
  }
  return out;
}

function parseFeedPayload(json, sourceUrl = '') {
  if (!json || typeof json !== 'object') return [];
  const sportGuess = inferSportFromUrl(sourceUrl);
  const out = [];

  // 0. The Odds API v4 (top-level JSON array of events with home_team/away_team + bookmakers/scores)
  if (Array.isArray(json)) {
    return parseOddsApiEvents(json);
  }

  // 1. ESPN Public Scoreboard API (events[].competitions[0].competitors[])
  if (Array.isArray(json.events) && json.events[0]?.competitions) {
    const leagueName = json.leagues?.[0]?.abbreviation || json.leagues?.[0]?.name || `${sportGuess} Live`;
    for (const ev of json.events.slice(0, 14)) {
      const comp = ev.competitions?.[0];
      const comps = comp?.competitors || [];
      const homeObj = comps.find(c => c.homeAway === 'home') || comps[0];
      const awayObj = comps.find(c => c.homeAway === 'away') || comps[1];
      if (!homeObj || !awayObj) continue;
      const stState = comp?.status?.type?.state || ev?.status?.type?.state || '';
      const completed = Boolean(comp?.status?.type?.completed || stState === 'post');
      const status = completed ? 'FT' : 'LIVE';
      const hs = Math.max(0, parseInt(homeObj.score || '0', 10) || 0);
      const as = Math.max(0, parseInt(awayObj.score || '0', 10) || 0);
      const clock = comp?.status?.displayClock || comp?.status?.type?.shortDetail || (completed ? 'FT' : "45'");
      const progress = completed ? 1 : (stState === 'pre' ? 0.08 : 0.55);
      out.push({
        id: `EXT-ESPN-${String(ev.id || '').replace(/[^A-Za-z0-9_-]/g, '')}`,
        sport: sportGuess,
        league: String(leagueName).slice(0, 40),
        home: String(homeObj.team?.shortDisplayName || homeObj.team?.displayName || 'Home').slice(0, 36),
        away: String(awayObj.team?.shortDisplayName || awayObj.team?.displayName || 'Away').slice(0, 36),
        homeScore: hs,
        awayScore: as,
        score: `${hs} - ${as}`,
        minute: completed ? 'FT' : String(clock).slice(0, 14),
        progress,
        status,
        markets: defaultMarketsForSport(sportGuess, hs, as)
      });
    }
    return out;
  }

  // 2. API-Football v3 (response[].fixture + teams + goals)
  if (Array.isArray(json.response) && json.response[0]?.teams) {
    for (const item of json.response.slice(0, 14)) {
      const fix = item.fixture || {};
      const hs = Math.max(0, parseInt(item.goals?.home ?? 0, 10) || 0);
      const as = Math.max(0, parseInt(item.goals?.away ?? 0, 10) || 0);
      const shortSt = fix.status?.short || 'LIVE';
      const status = normStatus(shortSt);
      const elapsed = fix.status?.elapsed ? `${fix.status.elapsed}'` : (status === 'FT' ? 'FT' : "1'");
      out.push({
        id: `EXT-APIFB-${String(fix.id || out.length + 1)}`,
        sport: 'Soccer',
        league: String(item.league?.name || 'Football Live').slice(0, 40),
        home: String(item.teams?.home?.name || 'Home').slice(0, 36),
        away: String(item.teams?.away?.name || 'Away').slice(0, 36),
        homeScore: hs,
        awayScore: as,
        score: `${hs} - ${as}`,
        minute: elapsed,
        progress: status === 'FT' ? 1 : Math.min(0.95, Math.max(0.05, Number(fix.status?.elapsed || 45) / 90)),
        status,
        markets: defaultMarketsForSport('Soccer', hs, as)
      });
    }
    return out;
  }

  // 3. Football-Data.org v4 (matches[].homeTeam + awayTeam + score)
  if (Array.isArray(json.matches)) {
    for (const m of json.matches.slice(0, 14)) {
      const hs = Math.max(0, parseInt(m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? 0, 10) || 0);
      const as = Math.max(0, parseInt(m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? 0, 10) || 0);
      const status = normStatus(m.status);
      out.push({
        id: `EXT-FD-${String(m.id || out.length + 1)}`,
        sport: 'Soccer',
        league: String(m.competition?.name || 'Football Live').slice(0, 40),
        home: String(m.homeTeam?.shortName || m.homeTeam?.name || 'Home').slice(0, 36),
        away: String(m.awayTeam?.shortName || m.awayTeam?.name || 'Away').slice(0, 36),
        homeScore: hs,
        awayScore: as,
        score: `${hs} - ${as}`,
        minute: status === 'FT' ? 'FT' : (m.minute ? `${m.minute}'` : "LIVE"),
        progress: status === 'FT' ? 1 : 0.45,
        status,
        markets: defaultMarketsForSport('Soccer', hs, as)
      });
    }
    return out;
  }

  // 4. TheSportsDB v1 (events[].strHomeTeam + strAwayTeam)
  if (Array.isArray(json.events)) {
    for (const ev of json.events.slice(0, 14)) {
      if (!ev.strHomeTeam || !ev.strAwayTeam) continue;
      const hs = Math.max(0, parseInt(ev.intHomeScore ?? 0, 10) || 0);
      const as = Math.max(0, parseInt(ev.intAwayScore ?? 0, 10) || 0);
      const status = normStatus(ev.strStatus);
      const sp = /basket/i.test(ev.strSport || '') ? 'Basketball' : (/box/i.test(ev.strSport || '') ? 'Boxing' : 'Soccer');
      out.push({
        id: `EXT-TSDB-${String(ev.idEvent || out.length + 1)}`,
        sport: sp,
        league: String(ev.strLeague || 'Live League').slice(0, 40),
        home: String(ev.strHomeTeam).slice(0, 36),
        away: String(ev.strAwayTeam).slice(0, 36),
        homeScore: hs,
        awayScore: as,
        score: `${hs} - ${as}`,
        minute: status === 'FT' ? 'FT' : String(ev.strProgress || "LIVE").slice(0, 14),
        progress: status === 'FT' ? 1 : 0.4,
        status,
        markets: defaultMarketsForSport(sp, hs, as)
      });
    }
  }

  return out;
}

async function fetchSportsFeedDetailed(url, apiKey = '') {
  const cleanUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    throw new Error('SPORTS_API_URL must start with http:// or https://');
  }
  const targetUrl = buildFeedRequestUrl(cleanUrl, apiKey);
  const resp = await fetch(targetUrl, {
    headers: buildFeedRequestHeaders(targetUrl, apiKey),
    signal: AbortSignal.timeout(8000)
  });
  const remRaw = resp.headers?.get?.('x-requests-remaining');
  const remainingRequests = remRaw != null && remRaw !== '' ? parseInt(remRaw, 10) : null;
  if (!resp.ok) {
    throw new Error(`Sports feed returned HTTP ${resp.status} (${sanitizeUrlForLog(targetUrl)})`);
  }
  const json = await resp.json();
  return {
    fixtures: parseFeedPayload(json, targetUrl),
    remainingRequests: Number.isFinite(remainingRequests) ? remainingRequests : null
  };
}

async function fetchSportsFeed(url, apiKey = '') {
  const res = await fetchSportsFeedDetailed(url, apiKey);
  return res.fixtures;
}

module.exports = {
  inferSportFromUrl,
  isOddsApiUrl,
  buildFeedRequestUrl,
  buildFeedRequestHeaders,
  sanitizeUrlForLog,
  parseFeedPayload,
  fetchSportsFeedDetailed,
  fetchSportsFeed
};
