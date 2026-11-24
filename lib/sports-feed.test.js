'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeedPayload, buildFeedRequestHeaders } = require('./sports-feed');

test('buildFeedRequestHeaders sets auth headers for Football-Data and API-Football only when key given', () => {
  const hEspn = buildFeedRequestHeaders('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard', '');
  assert.equal(hEspn['X-Auth-Token'], undefined);
  assert.equal(hEspn['x-apisports-key'], undefined);

  const hFd = buildFeedRequestHeaders('https://api.football-data.org/v4/matches', 'fd_key_123');
  assert.equal(hFd['X-Auth-Token'], 'fd_key_123');

  const hApiFb = buildFeedRequestHeaders('https://v3.football.api-sports.io/fixtures?live=all', 'af_key_456');
  assert.equal(hApiFb['x-apisports-key'], 'af_key_456');
});

test('parseFeedPayload normalizes ESPN, Football-Data, API-Football, and TheSportsDB payloads', () => {
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
