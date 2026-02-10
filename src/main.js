import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.1.0/+esm';

const game = new Chess();
let board;
let allMovesResult = [];

const el = {
  fenInput: document.getElementById('fenInput'),
  pgnInput: document.getElementById('pgnInput'),
  moveList: document.getElementById('moveList'),
  status: document.getElementById('engineStatus'),
  positionOutput: document.getElementById('positionOutput'),
  allMovesOutput: document.getElementById('allMovesOutput'),
  gameOutput: document.getElementById('gameOutput'),
  openingOutput: document.getElementById('openingOutput'),
  pieceBadges: document.getElementById('pieceBadges'),
  pieceMoves: document.getElementById('pieceMoves'),
  filterPiece: document.getElementById('filterPiece')
};

function renderMoves() {
  el.moveList.innerHTML = '';
  game.history({ verbose: true }).forEach((move, i) => {
    const li = document.createElement('li');
    li.textContent = `${Math.floor(i / 2) + 1}${i % 2 === 0 ? '. ' : '... '}${move.san}`;
    el.moveList.appendChild(li);
  });
  el.fenInput.value = game.fen();
}

function onDrop(source, target) {
  const move = game.move({ from: source, to: target, promotion: 'q' });
  if (!move) return 'snapback';
  renderMoves();
  return undefined;
}

function onSnapEnd() {
  board.position(game.fen());
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

async function analyzePosition() {
  try {
    const data = await postJson('/api/analyze/position', {
      fen: game.fen(),
      settings: { depth: Number(document.getElementById('depthSelect').value), multiPv: 5 }
    });

    el.positionOutput.textContent = data.topMoves
      .map((m, i) => `${i + 1}. ${m.uci}  eval ${(m.evalCp / 100).toFixed(2)}\n   pv: ${m.pv}`)
      .join('\n\n');
    el.status.textContent = `Position analysis complete (${data.source || 'stockfish'}).`;
  } catch (error) {
    el.positionOutput.textContent = `Error: ${error.message}`;
  }
}

function renderAllMoves(moves) {
  const filterPiece = el.filterPiece.value;
  const filtered = filterPiece ? moves.filter((m) => m.uci.startsWith(filterPiece)) : moves;
  const rows = filtered.map((m, idx) => `${idx + 1}. ${m.uci} eval ${(m.evalCp / 100).toFixed(2)} Δ${(m.deltaCp / 100).toFixed(2)} ${m.category.label}`);
  el.allMovesOutput.textContent = rows.join('\n');

  const bestByPiece = new Map();
  moves.forEach((m) => {
    const piece = m.uci[0];
    if (!bestByPiece.has(piece)) bestByPiece.set(piece, m);
  });

  el.pieceBadges.innerHTML = '';
  [...bestByPiece.entries()].forEach(([piece, move]) => {
    const btn = document.createElement('button');
    btn.className = `badge ${move.category.key}`;
    btn.textContent = `${piece.toUpperCase()}: ${move.uci} (${move.category.label})`;
    btn.addEventListener('click', () => {
      const perPiece = moves.filter((m) => m.uci.startsWith(piece));
      el.pieceMoves.textContent = perPiece.map((m) => `${m.uci}  ${(m.evalCp / 100).toFixed(2)}  ${m.category.label}`).join('\n');
    });
    el.pieceBadges.appendChild(btn);
  });
}

function runAllMoves() {
  el.allMovesOutput.textContent = 'Starting streaming analysis...';
  const es = new EventSourcePolyfill('/api/analyze/all-moves', {
    payload: JSON.stringify({ fen: game.fen(), settings: { movetimeMs: Number(document.getElementById('movetimeSelect').value) } })
  });

  const partial = [];
  es.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'partial') {
      partial.push(data.row);
      el.allMovesOutput.textContent = `Streaming... ${Math.round(data.progress * 100)}%\n` + partial.slice(-8).map((m) => `${m.uci} ${(m.evalCp / 100).toFixed(2)}`).join('\n');
    }

    if (data.type === 'final') {
      allMovesResult = data.result.moves;
      renderAllMoves(allMovesResult);
      es.close();
    }
  };

  es.onerror = () => {
    el.allMovesOutput.textContent = 'Streaming failed. Ensure Stockfish is available.';
    es.close();
  };
}

async function analyzeGame() {
  try {
    const replay = new Chess();
    replay.loadPgn(el.pgnInput.value, { strict: false });
    const hist = replay.history({ verbose: true });

    const fenSequence = [];
    const cursor = new Chess();
    hist.forEach((mv) => {
      cursor.move(mv);
      fenSequence.push(cursor.fen());
    });

    const data = await postJson('/api/analyze/game', {
      pgn: el.pgnInput.value,
      fenSequence,
      settings: { depth: Number(document.getElementById('depthSelect').value) }
    });

    el.gameOutput.textContent = `Opening: ${data.opening.eco} ${data.opening.name}\nPly: ${data.plyCount}\n\n` +
      data.plies.slice(0, 40).map((p) => `${p.ply}. ${p.san} eval ${(p.evalCp / 100).toFixed(2)} ${p.category.label}`).join('\n');
  } catch (error) {
    el.gameOutput.textContent = `Error: ${error.message}`;
  }
}

async function detectOpening() {
  const query = encodeURIComponent(game.history().join(' '));
  const res = await fetch(`/api/opening?moves=${query}`);
  const data = await res.json();
  el.openingOutput.textContent = `${data.eco} ${data.name}\nBook window: ${data.bookPlyRange[0]}-${data.bookPlyRange[1]}`;
}

function bindUI() {
  document.getElementById('flipBtn').addEventListener('click', () => board.flip());
  document.getElementById('resetBtn').addEventListener('click', () => {
    game.reset();
    board.start();
    renderMoves();
  });
  document.getElementById('loadFenBtn').addEventListener('click', () => {
    if (!game.load(el.fenInput.value.trim())) return;
    board.position(game.fen());
    renderMoves();
  });
  document.getElementById('analyzePositionBtn').addEventListener('click', analyzePosition);
  document.getElementById('analyzeAllMovesBtn').addEventListener('click', runAllMoves);
  document.getElementById('analyzeGameBtn').addEventListener('click', analyzeGame);
  document.getElementById('openingBtn').addEventListener('click', detectOpening);
  el.filterPiece.addEventListener('change', () => renderAllMoves(allMovesResult));
}

class EventSourcePolyfill {
  constructor(url, { payload }) {
    this.ctrl = new AbortController();
    this.onmessage = null;
    this.onerror = null;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: this.ctrl.signal
    }).then(async (res) => {
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ status: res.status, statusText: res.statusText }));
        if (this.onerror) this.onerror(errorData);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split('\n\n');
        buf = chunks.pop();
        chunks.forEach((chunk) => {
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line && this.onmessage) this.onmessage({ data: line.slice(6) });
        });
      }
    }).catch(() => this.onerror && this.onerror());
  }

  close() {
    this.ctrl.abort();
  }
}

board = window.Chessboard('board', {
  draggable: true,
  position: 'start',
  pieceTheme: 'https://unpkg.com/@chrisoakman/chessboardjs@1.0.0/www/img/chesspieces/wikipedia/{piece}.png',
  onDrop,
  onSnapEnd
});

bindUI();
renderMoves();
