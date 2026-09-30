import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_LIMIT, ImportError, fetchRecentGames } from '../src/game-import.js';

const pgn = (white, black, result, date) => `[Event "Rated game"]\n[Date "${date}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n\n1. e4 e5 ${result}`;

function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response('missing', { status: 404 });
    return typeof route === 'function' ? route() : new Response(route.body, { status: route.status || 200 });
  };
  return { fetchImpl, calls };
}

test('lichess games are read from NDJSON and variants are skipped', async () => {
  const url = `https://lichess.org/api/games/user/alice?max=${GAME_LIMIT}&pgnInJson=true`;
  const body = [
    { variant: 'standard', pgn: pgn('alice', 'bob', '1-0', '2026.09.20') },
    { variant: 'chess960', pgn: pgn('alice', 'carol', '0-1', '2026.09.19') },
    { variant: 'fromPosition', pgn: pgn('dave', 'alice', '1/2-1/2', '2026.09.18') }
  ].map((game) => JSON.stringify(game)).join('\n');
  const { fetchImpl, calls } = stubFetch({ [url]: { body } });
  const games = await fetchRecentGames('lichess', ' alice ', { fetchImpl });
  assert.deepEqual(games.map((g) => [g.white, g.black, g.result, g.date]), [
    ['alice', 'bob', '1-0', '2026-09-20'],
    ['dave', 'alice', '1/2-1/2', '2026-09-18']
  ]);
  assert.equal(calls[0].init.headers.Accept, 'application/x-ndjson');
});

test('chess.com games come newest first across monthly archives, standard rules only', async () => {
  const base = 'https://api.chess.com/pub/player/alice/games';
  const month = (games) => ({ body: JSON.stringify({ games }) });
  const { fetchImpl } = stubFetch({
    [`${base}/archives`]: { body: JSON.stringify({ archives: [`${base}/2026/08`, `${base}/2026/09`, 'https://evil.test/steal'] }) },
    [`${base}/2026/09`]: month([
      { rules: 'chess', end_time: 10, pgn: pgn('alice', 'bob', '1-0', '2026.09.01') },
      { rules: 'chess', end_time: 30, pgn: pgn('alice', 'carol', '0-1', '2026.09.03') },
      { rules: 'kingofthehill', end_time: 40, pgn: pgn('alice', 'eve', '1-0', '2026.09.04') }
    ]),
    [`${base}/2026/08`]: month([{ rules: 'chess', end_time: 5, pgn: pgn('dave', 'alice', '1-0', '2026.08.30') }])
  });
  const games = await fetchRecentGames('chesscom', 'Alice', { fetchImpl });
  assert.deepEqual(games.map((g) => g.black), ['carol', 'bob', 'alice']);
});

test('bad usernames, missing players and rate limits give readable errors', async () => {
  await assert.rejects(fetchRecentGames('lichess', 'a/../b'), ImportError);
  await assert.rejects(fetchRecentGames('lichess', 'x'), /2 to 30/);
  const { fetchImpl } = stubFetch({
    [`https://lichess.org/api/games/user/busy?max=${GAME_LIMIT}&pgnInJson=true`]: { status: 429, body: '{}' }
  });
  await assert.rejects(fetchRecentGames('lichess', 'busy', { fetchImpl }), /rate limiting/);
  await assert.rejects(fetchRecentGames('chesscom', 'nobody', { fetchImpl }), /No chess.com player/);
});
