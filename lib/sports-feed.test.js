'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseFeedPayload,
  buildFeedRequestHeaders,
  buildFeedRequestUrl,
  sanitizeUrlForLog
} = require('./sports-feed');

test('buildFeedRequestHeaders & buildFeedRequestUrl handle ESPN, Football-Data, API-Football, and The Odds API', () => {
  const hEspn = buildFeedRequestHeaders('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard', '');
  assert.equal(hEspn['X-Auth-Token'], undefined);
  assert.equal(hEspn['x-apisports-key'], undefined);

  const hFd = buildFeedRequestHeaders('https://api.football-data.org/v4/matches', 'fd_key_123');
  assert.equal(hFd['X-Auth-Token'], 'fd_key_123');

  const hApiFb = buildFeedRequestHeaders('https://v3.football.api-sports.io/fixtures?live=all', 'af_key_456');
  assert.equal(hApiFb['x-apisports-key'], 'af_key_456');

  // The Odds API: auto-upgrades /sport shorthand and puts key in query param (not Authorization header)
  const oddsUrl = buildFeedRequestUrl('https://api.the-odds-api.com/sport', 'my_secret_odds_key');
  const parsed = new URL(oddsUrl);
  assert.equal(parsed.pathname, '/v4/sports/upcoming/odds/');
  assert.equal(parsed.searchParams.get('regions'), 'eu');
  assert.equal(parsed.searchParams.get('markets'), 'h2h');
  assert.equal(parsed.searchParams.get('oddsFormat'), 'decimal');
  assert.equal(parsed.searchParams.get('apiKey'), 'my_secret_odds_key');

  const hOdds = buildFeedRequestHeaders(oddsUrl, 'my_secret_odds_key');
  assert.equal(hOdds['Authorization'], undefined);
  assert.equal(sanitizeUrlForLog(oddsUrl).includes('my_secret_odds_key'), false);
});

test('parseFeedPayload normalizes The Odds API v4, ESPN, Football-Data, API-Football, and TheSportsDB payloads', () => {
  // 0. The Odds API v4 (array with bookmakers + optional scores)
  const oddsApi = parseFeedPayload([
    {
      id: 'abc123event',
      sport_key: 'soccer_epl',
      sport_title: 'EPL',
      commence_time: new Date(Date.now() - 600000).toISOString(),
      completed: false,
      home_team: 'Arsenal',
      away_team: 'Chelsea',
      scores: [
        { name: 'Arsenal', score: '2' },
        { name: 'Chelsea', score: '1' }
      ],
      bookmakers: [
        {
          key: 'pinnacle',
          markets: [
            {
              key: 'h2h',
              outcomes: [
                { name: 'Arsenal', price: 1.75 },
                { name: 'Draw', price: 3.60 },
                { name: 'Chelsea', price: 4.50 }
              ]
            },
            {
              key: 'totals',
              outcomes: [
                { name: 'Over', point: 2.5, price: 1.85 },
                { name: 'Under', point: 2.5, price: 1.95 }
              ]
            }
          ]
        }
      ]
    }
  ], 'https://api.the-odds-api.com/v4/sports/upcoming/odds/');

  assert.equal(oddsApi.length, 1);
  assert.equal(oddsApi[0].id, 'EXT-ODDS-abc123event');
  assert.equal(oddsApi[0].sport, 'Soccer');
  assert.equal(oddsApi[0].league, 'EPL');
  assert.equal(oddsApi[0].score, '2 - 1');
  assert.equal(oddsApi[0].status, 'LIVE');
  assert.equal(oddsApi[0].markets.find(m => m.key === '1')?.odds, 1.75);
  assert.equal(oddsApi[0].markets.find(m => m.key === 'X')?.odds, 3.6);
  assert.equal(oddsApi[0].markets.find(m => m.key === '2')?.odds, 4.5);
  assert.equal(oddsApi[0].markets.find(m => m.key === 'O2.5')?.odds, 1.85);

  // 1. ESPN public scoreboard
  const espn = parseFeedPayload({
    leagues: [{ abbreviation: 'ENG.1' }],
    events: [{
      id: '704211',
      competitions: [{
        status: { displayClock: "67'", type: { state: 'in', completed: false } },
        competitors: [
          { homeAway: 'home', score: '2', team: { shortDisplayName: 'Arsenal' } },
          { homeAway: 'away', score: '1', team: { shortDisplayName: 'Chelsea' } }
        ]
      }]
    }]
  }, 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard');

  assert.equal(espn.length, 1);
  assert.equal(espn[0].id, 'EXT-ESPN-704211');
  assert.equal(espn[0].home, 'Arsenal');
  assert.equal(espn[0].away, 'Chelsea');
  assert.equal(espn[0].score, '2 - 1');
  assert.equal(espn[0].status, 'LIVE');
  assert.ok(espn[0].markets.length >= 3);

  // 2. Football-Data.org v4
  const fd = parseFeedPayload({
    matches: [{
      id: 9912,
      status: 'FINISHED',
      competition: { name: 'UEFA Champions League' },
      homeTeam: { shortName: 'Real Madrid' },
      awayTeam: { shortName: 'Liverpool' },
      score: { fullTime: { home: 3, away: 1 } }
    }]
  }, 'https://api.football-data.org/v4/matches');
  assert.equal(fd.length, 1);
  assert.equal(fd[0].status, 'FT');
  assert.equal(fd[0].score, '3 - 1');

  // 3. TheSportsDB
  const tsdb = parseFeedPayload({
    events: [{
      idEvent: '5511',
      strSport: 'Soccer',
      strLeague: 'Ethiopian Premier League',
      strHomeTeam: 'St George',
      strAwayTeam: 'Fasil Kenema',
      intHomeScore: '1',
      intAwayScore: '0',
      strStatus: 'IN_PLAY'
    }]
  }, 'https://www.thesportsdb.com/api/v1/json/3/eventsday.php');
  assert.equal(tsdb.length, 1);
  assert.equal(tsdb[0].home, 'St George');
  assert.equal(tsdb[0].away, 'Fasil Kenema');
  assert.equal(tsdb[0].status, 'LIVE');
});
