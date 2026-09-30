// Fetch a player's recent games from the public lichess and chess.com APIs.
// Both allow cross-origin reads without authentication, so the browser calls them directly.

export const GAME_LIMIT = 10;

// Both sites allow letters, digits, underscores and hyphens in usernames.
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{2,30}$/;
const CHESS_COM_ARCHIVE = /^https:\/\/api\.chess\.com\/pub\/player\/[^/]+\/games\/\d{4}\/\d{2}$/;

export class ImportError extends Error {}

function checkStatus(response, site) {
  if (response.status === 404) throw new ImportError(`No ${site} player with that username.`);
  if (response.status === 429) throw new ImportError(`${site} is rate limiting requests. Wait a minute and try again.`);
  if (!response.ok) throw new ImportError(`${site} returned HTTP ${response.status}.`);
}

// PGN tag pairs, e.g. [White "alice"], one per line.
const PGN_TAG = /^\[(\w+) "([^"]*)"\]/gm;

function pgnHeaders(pgn) {
  const headers = new Map();
  for (const [, name, value] of pgn.matchAll(PGN_TAG)) headers.set(name, value);
  return headers;
}

// A display summary; the PGN itself is what gets reviewed.
function summarise(pgn, players) {
  const headers = pgnHeaders(pgn);
  return {
    white: headers.get('White') || players.white || '?',
    black: headers.get('Black') || players.black || '?',
    result: headers.get('Result') || '*',
    date: (headers.get('UTCDate') || headers.get('Date') || '').replaceAll('.', '-'),
    pgn
  };
}

async function fetchLichessGames(username, { signal, fetchImpl }) {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${GAME_LIMIT}&pgnInJson=true`;
  const response = await fetchImpl(url, { headers: { Accept: 'application/x-ndjson' }, signal });
  checkStatus(response, 'lichess');
  const games = [];
  for (const line of (await response.text()).split('\n')) {
    if (!line.trim()) continue;
    const game = JSON.parse(line);
    // Only standard chess (including games from a set-up position) can be reviewed.
    if (typeof game.pgn !== 'string' || !['standard', 'fromPosition'].includes(game.variant)) continue;
    games.push(summarise(game.pgn, { white: game.players?.white?.user?.name, black: game.players?.black?.user?.name }));
  }
  return games;
}

async function fetchChessComGames(username, { signal, fetchImpl }) {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`;
  const archivesResponse = await fetchImpl(base, { signal });
  checkStatus(archivesResponse, 'chess.com');
  const { archives } = await archivesResponse.json();
  if (!Array.isArray(archives)) throw new ImportError('chess.com returned an unexpected response.');
  const games = [];
  // Archives are monthly and oldest first; walk back through recent months until there are enough games.
  for (const archive of archives.slice(-3).reverse()) {
    if (!CHESS_COM_ARCHIVE.test(archive)) continue;
    const monthResponse = await fetchImpl(archive, { signal });
    checkStatus(monthResponse, 'chess.com');
    const month = await monthResponse.json();
    const standard = (month.games || [])
      .filter((game) => game.rules === 'chess' && typeof game.pgn === 'string')
      .sort((a, b) => (b.end_time || 0) - (a.end_time || 0));
    games.push(...standard.map((game) => summarise(game.pgn, { white: game.white?.username, black: game.black?.username })));
    if (games.length >= GAME_LIMIT) break;
  }
  return games;
}

export async function fetchRecentGames(site, username, { signal, fetchImpl = fetch } = {}) {
  const name = String(username || '').trim();
  if (!USERNAME_PATTERN.test(name)) throw new ImportError('Enter a username of 2 to 30 letters, digits, "_" or "-".');
  let games;
  if (site === 'lichess') games = await fetchLichessGames(name, { signal, fetchImpl });
  else if (site === 'chesscom') games = await fetchChessComGames(name, { signal, fetchImpl });
  else throw new ImportError('Choose lichess or chess.com.');
  return games.slice(0, GAME_LIMIT);
}
