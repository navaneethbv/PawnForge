import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.1.0/+esm';

// ── State ──
const game = new Chess();
let board;
let allMovesResult = [];
let allMovesResultFen = null;
let gameReviewData = null;
let gameReviewPly = -1;
let gameReviewFens = [];
let gameReviewPreFens = [];

// ── Piece symbol map (for display) ──
const PIECE_SYMBOLS = { p: '', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };
const PIECE_UNICODE = {
  wp: '\u2659', wn: '\u2658', wb: '\u2657', wr: '\u2656', wq: '\u2655', wk: '\u2654',
  bp: '\u265F', bn: '\u265E', bb: '\u265D', br: '\u265C', bq: '\u265B', bk: '\u265A'
};

// ── DOM Elements ──
const el = {
  fenInput: document.getElementById('fenInput'),
  pgnInput: document.getElementById('pgnInput'),
  moveList: document.getElementById('moveList'),
  status: document.getElementById('engineStatus'),
  topMovesContainer: document.getElementById('topMovesContainer'),
  pvLines: document.getElementById('pvLines'),
  allMovesTable: document.getElementById('allMovesTable'),
  pieceBadges: document.getElementById('pieceBadges'),
  evalBarLabel: document.getElementById('evalBarLabel'),
  evalBarSegTop: document.getElementById('evalBarSegTop'),
  evalBarSegBot: document.getElementById('evalBarSegBot'),
  evalDisplay: document.getElementById('evalDisplay'),
  wdlW: document.getElementById('wdlW'),
  wdlD: document.getElementById('wdlD'),
  wdlL: document.getElementById('wdlL'),
  boardBadgeOverlay: document.getElementById('boardBadgeOverlay'),
  boardSquareHighlights: document.getElementById('boardSquareHighlights'),
  evalGraph: document.getElementById('evalGraph'),
  evalGraphContainer: document.getElementById('evalGraphContainer'),
  gameMoveList: document.getElementById('gameMoveList'),
  gameSummary: document.getElementById('gameSummary'),
  gameSummaryContent: document.getElementById('gameSummaryContent'),
  gameProgress: document.getElementById('gameProgress'),
  gameProgressFill: document.getElementById('gameProgressFill'),
  gameProgressText: document.getElementById('gameProgressText'),
  gameReviewNav: document.getElementById('gameReviewNav'),
  explorerProgress: document.getElementById('explorerProgress'),
  explorerProgressFill: document.getElementById('explorerProgressFill'),
  explorerProgressText: document.getElementById('explorerProgressText'),
  explorerFilters: document.getElementById('explorerFilters'),
  openingResult: document.getElementById('openingResult'),
  openingContinuations: document.getElementById('openingContinuations'),
  filterPiece: document.getElementById('filterPiece'),
  sortMoves: document.getElementById('sortMoves')
};

// ── Board orientation tracking ──
let boardFlipped = false;
let lastHighlight = null; // { from, to, category }

// ── Engine status ──
function setEngineStatus(text, state = 'idle') {
  el.status.innerHTML = `<span class="dot"></span> ${text}`;
  el.status.className = 'engine-indicator' + (state === 'active' ? ' active' : state === 'error' ? ' error' : '');
}

// ── Win/Draw/Loss from centipawns (estimated logistic model) ──
function cpToWDL(cp) {
  // Approximate WDL using a logistic curve (not engine-grade, heuristic only)
  // Based on Lichess WDL model parameters
  const K = -0.00368208;
  const winP = 1 / (1 + Math.exp(K * cp));
  // Draw probability peaks near 0 eval
  const drawBase = Math.max(0, 0.5 - Math.abs(cp) / 1200);
  const w = Math.max(0, Math.min(1, winP - drawBase / 2));
  const l = Math.max(0, Math.min(1, (1 - winP) - drawBase / 2));
  const d = Math.max(0, 1 - w - l);
  return { w: w * 100, d: d * 100, l: l * 100 };
}

// ── Eval bar (GPU-accelerated with scaleY) ──
function updateEvalBar(evalCp) {
  const clamped = Math.max(-1000, Math.min(1000, evalCp));
  // White portion (bottom segment): 0.5 = even, 1.0 = white winning
  const whitePct = 0.5 + (clamped / 1000) * 0.5;
  const blackPct = 1 - whitePct;

  el.evalBarSegTop.style.transform = `translateZ(0) scaleY(${blackPct.toFixed(4)})`;
  el.evalBarSegBot.style.transform = `translateZ(0) scaleY(${whitePct.toFixed(4)})`;

  const isMate = Math.abs(evalCp) >= 100000;
  const display = isMate
    ? (evalCp > 0 ? 'M' : '-M')
    : (evalCp / 100).toFixed(1);
  el.evalBarLabel.textContent = display;

  // Update eval display and W/D/L
  const evalText = isMate
    ? (evalCp > 0 ? '#' : '-#')
    : (evalCp >= 0 ? '+' : '') + (evalCp / 100).toFixed(2);
  el.evalDisplay.textContent = evalText;

  const wdl = cpToWDL(evalCp);
  el.wdlW.textContent = wdl.w.toFixed(1);
  el.wdlD.textContent = wdl.d.toFixed(1);
  el.wdlL.textContent = wdl.l.toFixed(1);
}

// ── Board square coordinate helpers ──
function squareToCoords(sq) {
  const file = sq.charCodeAt(0) - 97; // a=0, h=7
  const rank = parseInt(sq[1]) - 1;   // 1=0, 8=7
  return { file, rank };
}

function squareToPosition(sq) {
  const { file, rank } = squareToCoords(sq);
  if (boardFlipped) {
    return { left: (7 - file) * 12.5, top: rank * 12.5 };
  }
  return { left: file * 12.5, top: (7 - rank) * 12.5 };
}

// ── On-board eval badges ──
function renderBoardBadges(moves, fen) {
  el.boardBadgeOverlay.innerHTML = '';
  if (!moves || moves.length === 0) return;

  moves.forEach((m) => {
    const to = m.uci.substring(2, 4);
    const cat = m.category || classify(m.deltaCp || 0);
    const pos = squareToPosition(to);

    const badge = document.createElement('div');
    badge.className = `board-eval-badge cat-${cat.key}`;
    badge.style.left = `${pos.left}%`;
    badge.style.top = `${pos.top}%`;

    const label = document.createElement('span');
    label.className = 'badge-label';
    const whiteEval = toWhiteRelativeEval(m.evalCp, fen);
    const evalVal = whiteEval / 100;
    label.textContent = evalVal >= 0 ? `+${Math.round(evalVal)}` : `${Math.round(evalVal)}`;

    badge.appendChild(label);
    el.boardBadgeOverlay.appendChild(badge);
  });
}

function clearBoardBadges() {
  el.boardBadgeOverlay.innerHTML = '';
}

// ── Last-move square highlighting ──
function highlightLastMove(from, to, category) {
  lastHighlight = { from, to, category };
  el.boardSquareHighlights.innerHTML = '';
  const cls = category ? `highlight-${category}` : 'highlight-neutral';

  [from, to].forEach((sq) => {
    const pos = squareToPosition(sq);
    const div = document.createElement('div');
    div.className = `board-square-highlight ${cls}`;
    div.style.left = `${pos.left}%`;
    div.style.top = `${pos.top}%`;
    el.boardSquareHighlights.appendChild(div);
  });
}

function clearSquareHighlights() {
  lastHighlight = null;
  el.boardSquareHighlights.innerHTML = '';
}

// ── Tab switching ──
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      const tab = document.getElementById(`tab-${btn.dataset.tab}`);
      if (tab) tab.classList.add('active');
    });
  });
}

// ── Move list rendering ──
function renderMoves() {
  el.moveList.innerHTML = '';
  const history = game.history({ verbose: true });

  for (let i = 0; i < history.length; i += 2) {
    const moveNum = Math.floor(i / 2) + 1;
    const pair = document.createElement('div');
    pair.className = 'move-pair';

    const num = document.createElement('span');
    num.className = 'move-number';
    num.textContent = `${moveNum}.`;
    pair.appendChild(num);

    const white = document.createElement('span');
    white.className = 'move-san';
    white.textContent = history[i].san;
    white.dataset.ply = i;
    pair.appendChild(white);

    if (history[i + 1]) {
      const black = document.createElement('span');
      black.className = 'move-san';
      black.textContent = history[i + 1].san;
      black.dataset.ply = i + 1;
      pair.appendChild(black);
    }

    el.moveList.appendChild(pair);
  }

  el.fenInput.value = game.fen();
}

// ── Board event handlers ──
function onDrop(source, target) {
  const move = game.move({ from: source, to: target, promotion: 'q' });
  if (!move) return 'snapback';
  renderMoves();
  clearBoardBadges();
  allMovesResult = [];
  allMovesResultFen = null;
  highlightLastMove(source, target, null);
  return undefined;
}

function onSnapEnd() {
  board.position(game.fen());
}

// ── API helpers ──
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

// ── Classify move quality (matches server thresholds) ──
function classify(deltaCp) {
  if (deltaCp <= 20) return { key: 'best', label: 'Best' };
  if (deltaCp <= 60) return { key: 'good', label: 'Good' };
  if (deltaCp <= 150) return { key: 'inaccuracy', label: 'Inaccuracy' };
  if (deltaCp <= 300) return { key: 'mistake', label: 'Mistake' };
  return { key: 'blunder', label: 'Blunder' };
}

// ── Convert side-to-move eval to White-relative eval ──
function toWhiteRelativeEval(evalCp, fen) {
  const turn = fen.split(' ')[1];
  return turn === 'b' ? -evalCp : evalCp;
}

// ── Format eval for display (expects White-relative cp) ──
function formatEval(cp) {
  if (Math.abs(cp) >= 100000) return cp > 0 ? '#' : '-#';
  const val = (cp / 100).toFixed(2);
  return cp > 0 ? `+${val}` : val;
}

// ── Position Analysis ──
async function analyzePosition() {
  setEngineStatus('Analyzing position...', 'active');
  try {
    const depth = Number(document.getElementById('depthSelect').value);
    const multiPv = Number(document.getElementById('multipvSelect').value);
    const data = await postJson('/api/analyze/position', {
      fen: game.fen(),
      settings: { depth, multiPv }
    });

    // Convert evals to White-relative for display
    const fen = game.fen();

    // Update eval bar
    if (data.topMoves && data.topMoves.length > 0) {
      updateEvalBar(toWhiteRelativeEval(data.bestEvalCp, fen));
    }

    // Render top moves summary
    el.topMovesContainer.innerHTML = '';
    if (data.topMoves && data.topMoves.length > 0) {
      const summary = document.createElement('div');
      summary.style.cssText = 'display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.5rem;';
      data.topMoves.forEach((m) => {
        const whiteEval = toWhiteRelativeEval(m.evalCp, fen);
        const cls = whiteEval >= 0 ? 'white-advantage' : 'black-advantage';
        const badge = document.createElement('span');
        badge.className = `pv-eval ${cls}`;
        badge.textContent = `${m.uci.substring(0, 4)} ${formatEval(whiteEval)}`;
        badge.style.cursor = 'default';
        badge.style.fontSize = '0.82rem';
        summary.appendChild(badge);
      });
      el.topMovesContainer.appendChild(summary);
    }

    // Render PV lines
    el.pvLines.innerHTML = '';
    data.topMoves.forEach((m, i) => {
      const line = document.createElement('div');
      line.className = 'pv-line';

      const rank = document.createElement('span');
      rank.className = 'pv-rank';
      rank.textContent = `#${i + 1}`;

      const whiteEval = toWhiteRelativeEval(m.evalCp, fen);
      const evalEl = document.createElement('span');
      const cls = whiteEval >= 0 ? 'white-advantage' : 'black-advantage';
      evalEl.className = `pv-eval ${cls}`;
      evalEl.textContent = formatEval(whiteEval);

      const moves = document.createElement('span');
      moves.className = 'pv-moves';
      moves.textContent = m.pv;

      line.appendChild(rank);
      line.appendChild(evalEl);
      line.appendChild(moves);
      el.pvLines.appendChild(line);
    });

    setEngineStatus(`Analysis complete (depth ${depth})`, 'idle');
  } catch (error) {
    el.topMovesContainer.innerHTML = `<div class="placeholder-text">Error: ${error.message}</div>`;
    setEngineStatus('Analysis failed', 'error');
  }
}

// ── SSE Polyfill for POST requests ──
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
    })
      .then(async (res) => {
        if (!res.ok) {
          let details = '';
          try { details = await res.text(); } catch (_e) { details = ''; }
          throw new Error(details || `Request failed with status ${res.status}`);
        }
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
          let details = '';
          try { details = await res.text(); } catch (_e) { details = ''; }
          throw new Error(details || `Expected SSE but got: ${contentType}`);
        }
        if (!res.body) throw new Error('Response body not readable');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const chunks = buf.split('\n\n');
          buf = chunks.pop() || '';
          chunks.forEach((chunk) => {
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line && this.onmessage) this.onmessage({ data: line.slice(6) });
          });
        }
      })
      .catch((error) => {
        if (this.onerror) this.onerror(error);
      });
  }
  close() { this.ctrl.abort(); }
}

// ── Determine piece type from UCI move + FEN ──
function getPieceAtSquare(fen, uciMove) {
  const tmpGame = new Chess(fen);
  const from = uciMove.substring(0, 2);
  const piece = tmpGame.get(from);
  if (!piece) return { type: 'p', color: 'w' };
  return piece;
}

// ── Render piece badges for all-moves explorer ──
function renderPieceBadges(moves, fen) {
  el.pieceBadges.innerHTML = '';
  if (!moves || moves.length === 0) return;

  // Group moves by piece
  const byPiece = new Map();
  moves.forEach((m) => {
    const piece = getPieceAtSquare(fen, m.uci);
    const key = `${piece.color}${piece.type}`;
    if (!byPiece.has(key)) byPiece.set(key, []);
    byPiece.get(key).push(m);
  });

  // Order: K, Q, R, B, N, P
  const order = ['k', 'q', 'r', 'b', 'n', 'p'];
  const turn = fen.split(' ')[1] || 'w';
  const sortedKeys = [...byPiece.keys()].sort((a, b) => {
    return order.indexOf(a[1]) - order.indexOf(b[1]);
  });

  sortedKeys.forEach((key) => {
    const pieceMoves = byPiece.get(key);
    const best = pieceMoves[0]; // Already sorted by eval
    const cat = best.category || classify(best.deltaCp || 0);

    const badge = document.createElement('div');
    badge.className = `piece-badge cat-${cat.key}`;

    const icon = document.createElement('span');
    icon.className = 'piece-icon';
    icon.textContent = PIECE_UNICODE[key] || key;

    const moveText = document.createElement('span');
    moveText.className = 'piece-best-move';
    moveText.textContent = best.san || best.uci;

    const evalText = document.createElement('span');
    evalText.className = 'piece-eval';
    const bestWhiteEval = toWhiteRelativeEval(best.evalCp, fen);
    evalText.textContent = `${formatEval(bestWhiteEval)} (${cat.label})`;

    badge.appendChild(icon);
    badge.appendChild(moveText);
    badge.appendChild(evalText);

    badge.addEventListener('click', () => {
      document.querySelectorAll('.piece-badge').forEach((b) => b.classList.remove('selected'));
      badge.classList.add('selected');
      renderMovesTable(pieceMoves, fen);
    });

    el.pieceBadges.appendChild(badge);
  });
}

// ── Render all-moves table ──
function renderMovesTable(moves, fen) {
  if (!moves || moves.length === 0) {
    el.allMovesTable.innerHTML = '<div class="placeholder-text">No moves to display.</div>';
    return;
  }

  const fenForRender = fen || allMovesResultFen || game.fen();
  let html = '<table><thead><tr><th>#</th><th>Move</th><th>Eval</th><th>Delta</th><th>Quality</th></tr></thead><tbody>';
  moves.forEach((m, i) => {
    const cat = m.category || classify(m.deltaCp || 0);
    const whiteEval = toWhiteRelativeEval(m.evalCp, fenForRender);
    html += `<tr>
      <td>${i + 1}</td>
      <td class="move-cell">${m.san || m.uci}</td>
      <td>${formatEval(whiteEval)}</td>
      <td>${m.deltaCp !== undefined ? (m.deltaCp / 100).toFixed(2) : '-'}</td>
      <td><span class="eval-badge ${cat.key}">${cat.label}</span></td>
    </tr>`;
  });
  html += '</tbody></table>';
  el.allMovesTable.innerHTML = html;
}

// ── All-moves explorer with streaming ──
function runAllMoves() {
  setEngineStatus('Evaluating all legal moves...', 'active');
  el.explorerProgress.style.display = 'flex';
  el.explorerProgressFill.style.width = '0%';
  el.explorerProgressText.textContent = 'Starting...';
  el.pieceBadges.innerHTML = '';
  el.allMovesTable.innerHTML = '';
  el.explorerFilters.style.display = 'none';
  allMovesResult = [];
  allMovesResultFen = null;

  const currentFen = game.fen();

  const es = new EventSourcePolyfill('/api/analyze/all-moves', {
    payload: JSON.stringify({
      fen: currentFen,
      settings: { movetimeMs: Number(document.getElementById('movetimeSelect').value) }
    })
  });

  const partial = [];
  es.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'partial') {
      partial.push(data.row);
      const pct = Math.round(data.progress * 100);
      el.explorerProgressFill.style.width = `${pct}%`;
      el.explorerProgressText.textContent = `${pct}% (${partial.length} moves evaluated)`;
    }

    if (data.type === 'final') {
      allMovesResult = data.result.moves;
      allMovesResultFen = currentFen;

      // Add SAN notation to moves
      const tmpGame = new Chess(currentFen);
      allMovesResult.forEach((m) => {
        try {
          const from = m.uci.substring(0, 2);
          const to = m.uci.substring(2, 4);
          const promo = m.uci.length > 4 ? m.uci[4] : undefined;
          const moveObj = tmpGame.move({ from, to, promotion: promo });
          if (moveObj) {
            m.san = moveObj.san;
            m.flags = moveObj.flags;
            tmpGame.undo();
          }
        } catch (_e) {
          m.san = m.uci;
        }
      });

      renderPieceBadges(allMovesResult, currentFen);
      renderMovesTable(allMovesResult, currentFen);
      renderBoardBadges(allMovesResult, currentFen);
      el.explorerFilters.style.display = 'flex';
      el.explorerProgress.style.display = 'none';
      setEngineStatus(`All-moves complete (${allMovesResult.length} moves)`, 'idle');
      es.close();
    }
  };

  es.onerror = (error) => {
    const msg = error && error.message ? error.message : 'Streaming failed';
    el.allMovesTable.innerHTML = `<div class="placeholder-text">Error: ${msg}</div>`;
    el.explorerProgress.style.display = 'none';
    setEngineStatus('Explorer failed', 'error');
    es.close();
  };
}

// ── Eval graph drawing ──
function drawEvalGraph(plies, activePly = -1) {
  const canvas = el.evalGraph;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Set actual pixel size
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const pad = { top: 10, bottom: 20, left: 5, right: 5 };
  const gw = w - pad.left - pad.right;
  const gh = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  if (!plies || plies.length === 0) return;

  // Clamp eval values for graph display
  const maxEval = 500; // 5 pawns
  const clamp = (v) => Math.max(-maxEval, Math.min(maxEval, v));

  // Draw background halves
  const midY = pad.top + gh / 2;

  // White half (bottom)
  ctx.fillStyle = 'rgba(241,245,249,0.06)';
  ctx.fillRect(pad.left, midY, gw, gh / 2);

  // Black half (top)
  ctx.fillStyle = 'rgba(30,41,59,0.3)';
  ctx.fillRect(pad.left, pad.top, gw, gh / 2);

  // Draw zero line
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, midY);
  ctx.lineTo(pad.left + gw, midY);
  ctx.stroke();

  // Draw eval curve
  const xStep = gw / Math.max(1, plies.length - 1);

  // Fill area under curve
  ctx.beginPath();
  ctx.moveTo(pad.left, midY);
  plies.forEach((p, i) => {
    const x = pad.left + i * xStep;
    const whiteEval = toWhiteRelativeEval(p.evalCp, p.fen);
    const evalClamped = clamp(whiteEval);
    const y = midY - (evalClamped / maxEval) * (gh / 2);
    ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.left + (plies.length - 1) * xStep, midY);
  ctx.closePath();
  ctx.fillStyle = 'rgba(59,130,246,0.15)';
  ctx.fill();

  // Draw line
  ctx.beginPath();
  plies.forEach((p, i) => {
    const x = pad.left + i * xStep;
    const whiteEval = toWhiteRelativeEval(p.evalCp, p.fen);
    const evalClamped = clamp(whiteEval);
    const y = midY - (evalClamped / maxEval) * (gh / 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw markers for mistakes/blunders
  plies.forEach((p, i) => {
    if (!p.category) return;
    const x = pad.left + i * xStep;
    const whiteEval = toWhiteRelativeEval(p.evalCp, p.fen);
    const evalClamped = clamp(whiteEval);
    const y = midY - (evalClamped / maxEval) * (gh / 2);

    if (p.category.key === 'mistake' || p.category.key === 'blunder') {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = p.category.key === 'blunder' ? '#dc2626' : '#ef4444';
      ctx.fill();
    }
  });

  // Draw active ply marker
  if (activePly >= 0 && activePly < plies.length) {
    const x = pad.left + activePly * xStep;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + gh);
    ctx.stroke();

    const activeWhiteEval = toWhiteRelativeEval(plies[activePly].evalCp, plies[activePly].fen);
    const evalClamped = clamp(activeWhiteEval);
    const y = midY - (evalClamped / maxEval) * (gh / 2);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Draw move numbers on bottom
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.floor(plies.length / 10));
  for (let i = 0; i < plies.length; i += step) {
    const x = pad.left + i * xStep;
    const moveNum = Math.floor(i / 2) + 1;
    ctx.fillText(moveNum.toString(), x, h - 4);
  }
}

// ── Game analysis ──
async function analyzeGame() {
  try {
    setEngineStatus('Analyzing game...', 'active');
    el.gameProgress.style.display = 'flex';
    el.gameProgressFill.style.width = '0%';
    el.gameProgressText.textContent = 'Parsing PGN...';

    const replay = new Chess();
    replay.loadPgn(el.pgnInput.value, { strict: false });
    const hist = replay.history({ verbose: true });

    if (hist.length === 0) {
      throw new Error('No moves found in PGN');
    }

    const fenSequence = [];
    const preMoveSequence = [];
    const cursor = new Chess();
    hist.forEach((mv) => {
      preMoveSequence.push(cursor.fen());
      cursor.move(mv);
      fenSequence.push(cursor.fen());
    });

    gameReviewFens = fenSequence;
    gameReviewPreFens = preMoveSequence;

    el.gameProgressText.textContent = `Analyzing ${hist.length} plies...`;
    el.gameProgressFill.style.width = '10%';

    const data = await postJson('/api/analyze/game', {
      pgn: el.pgnInput.value,
      fenSequence,
      preMoveSequence,
      settings: { depth: Number(document.getElementById('gameDepthSelect').value) }
    });

    gameReviewData = data;
    el.gameProgressFill.style.width = '100%';
    el.gameProgressText.textContent = 'Complete!';

    setTimeout(() => { el.gameProgress.style.display = 'none'; }, 1000);

    // Draw eval graph
    el.evalGraphContainer.style.display = 'block';
    drawEvalGraph(data.plies);

    // Show navigation
    el.gameReviewNav.style.display = 'flex';

    // Render annotated move list
    renderGameMoveList(data, hist);

    // Render game summary
    renderGameSummary(data, hist);

    setEngineStatus('Game analysis complete', 'idle');
  } catch (error) {
    el.gameMoveList.innerHTML = `<div class="placeholder-text">Error: ${error.message}</div>`;
    el.gameProgress.style.display = 'none';
    setEngineStatus('Game analysis failed', 'error');
  }
}

function renderGameMoveList(data, hist) {
  el.gameMoveList.innerHTML = '';

  data.plies.forEach((p, i) => {
    if (i % 2 === 0) {
      const numSpan = document.createElement('span');
      numSpan.className = 'game-move-number';
      numSpan.textContent = `${Math.floor(i / 2) + 1}.`;
      el.gameMoveList.appendChild(numSpan);
    }

    const moveEl = document.createElement('span');
    moveEl.className = `game-move cat-${p.category.key}`;
    moveEl.textContent = p.san;
    moveEl.dataset.ply = i;
    const whiteEval = toWhiteRelativeEval(p.evalCp, p.fen);
    moveEl.title = `${formatEval(whiteEval)} (${p.category.label}, delta: ${(p.deltaCp / 100).toFixed(2)})`;

    moveEl.addEventListener('click', () => {
      navigateToGamePly(i);
    });

    el.gameMoveList.appendChild(moveEl);
  });
}

function navigateToGamePly(ply) {
  if (!gameReviewData || ply < 0 || ply >= gameReviewData.plies.length) return;

  gameReviewPly = ply;
  const fen = gameReviewFens[ply];
  const plyData = gameReviewData.plies[ply];

  // Update board
  game.load(fen);
  board.position(fen);
  el.fenInput.value = fen;

  // Update eval bar (White-relative)
  updateEvalBar(toWhiteRelativeEval(plyData.evalCp, fen));

  // Highlight last move squares with category color
  clearBoardBadges();
  if (gameReviewPreFens[ply]) {
    const tmpGame = new Chess(gameReviewPreFens[ply]);
    const move = tmpGame.move(plyData.san);
    if (move) {
      highlightLastMove(move.from, move.to, plyData.category.key);
    }
  }

  // Highlight active move
  document.querySelectorAll('.game-move').forEach((m) => m.classList.remove('active'));
  const active = document.querySelector(`.game-move[data-ply="${ply}"]`);
  if (active) {
    active.classList.add('active');
    active.scrollIntoView({ block: 'nearest' });
  }

  // Update eval graph
  drawEvalGraph(gameReviewData.plies, ply);
}

function renderGameSummary(data, hist) {
  el.gameSummary.style.display = 'block';

  // Count categories per side
  const white = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, totalDelta: 0, count: 0 };
  const black = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, totalDelta: 0, count: 0 };

  data.plies.forEach((p, i) => {
    const side = i % 2 === 0 ? white : black;
    side[p.category.key] = (side[p.category.key] || 0) + 1;
    side.totalDelta += p.deltaCp;
    side.count += 1;
  });

  const whiteAcpl = white.count > 0 ? (white.totalDelta / white.count).toFixed(1) : '0';
  const blackAcpl = black.count > 0 ? (black.totalDelta / black.count).toFixed(1) : '0';

  el.gameSummaryContent.innerHTML = `
    <div style="margin-bottom:0.5rem;">
      <span class="opening-eco">${data.opening.eco}</span>
      <strong>${data.opening.name}</strong>
      <span style="color:var(--text-muted); font-size:0.82rem;"> &bull; ${data.plyCount} plies</span>
    </div>
    <div class="summary-grid">
      <div class="summary-card">
        <div class="label">White ACPL</div>
        <div class="value white">${whiteAcpl}</div>
      </div>
      <div class="summary-card">
        <div class="label">Black ACPL</div>
        <div class="value black">${blackAcpl}</div>
      </div>
      <div class="summary-card">
        <div class="label">White Mistakes/Blunders</div>
        <div class="value" style="color:var(--mistake)">${white.mistake + white.blunder}</div>
      </div>
      <div class="summary-card">
        <div class="label">Black Mistakes/Blunders</div>
        <div class="value" style="color:var(--mistake)">${black.mistake + black.blunder}</div>
      </div>
      <div class="summary-card">
        <div class="label">Turning Points</div>
        <div class="value">${data.turningPoints.length}</div>
      </div>
      <div class="summary-card">
        <div class="label">Book Window</div>
        <div class="value">${data.opening.bookPlyRange[0]}-${data.opening.bookPlyRange[1]}</div>
      </div>
    </div>
  `;
}

// ── Opening detection ──
async function detectOpening() {
  try {
    setEngineStatus('Detecting opening...', 'active');
    const query = encodeURIComponent(game.history().join(' '));
    const res = await fetch(`/api/opening?moves=${query}`);
    if (!res.ok) throw new Error(`Failed (${res.status})`);
    const data = await res.json();

    el.openingResult.innerHTML = `
      <div class="opening-name">
        <span class="opening-eco">${data.eco}</span>
        ${data.name}
      </div>
      <div class="opening-meta">Book window: ply ${data.bookPlyRange[0]}-${data.bookPlyRange[1]}</div>
    `;

    // Show continuations if available
    if (data.continuations && data.continuations.length > 0) {
      el.openingContinuations.innerHTML = '<h3 style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.4rem;">Common continuations</h3>';
      data.continuations.forEach((c) => {
        const row = document.createElement('div');
        row.className = 'continuation-row';
        row.innerHTML = `
          <span class="continuation-move">${c.move}</span>
          <span class="continuation-name">${c.name}</span>
          <span class="continuation-freq">${c.eco}</span>
        `;
        row.addEventListener('click', () => {
          game.move(c.move);
          board.position(game.fen());
          renderMoves();
        });
        el.openingContinuations.appendChild(row);
      });
    }

    setEngineStatus('Opening detected', 'idle');
  } catch (error) {
    el.openingResult.innerHTML = `<div class="placeholder-text">Error: ${error.message}</div>`;
    setEngineStatus('Opening detection failed', 'error');
  }
}

// ── Filter/sort for explorer ──
function applyExplorerFilters() {
  if (!allMovesResult || allMovesResult.length === 0) return;

  let filtered = [...allMovesResult];
  const filterVal = el.filterPiece.value;

  if (filterVal === 'captures') {
    filtered = filtered.filter((m) => m.flags && m.flags.includes('c'));
  } else if (filterVal === 'checks') {
    filtered = filtered.filter((m) => m.san && (m.san.includes('+') || m.san.includes('#')));
  }

  const sortVal = el.sortMoves.value;
  if (sortVal === 'delta') {
    filtered.sort((a, b) => (a.deltaCp || 0) - (b.deltaCp || 0));
  } else if (sortVal === 'piece') {
    const fen = allMovesResultFen || game.fen();
    const order = { k: 0, q: 1, r: 2, b: 3, n: 4, p: 5 };
    // Precompute the moving piece type for each move using a single Chess instance
    const chess = new Chess(fen);
    const pieceCache = {};
    for (const m of filtered) {
      if (!m.uci || pieceCache[m.uci]) continue;
      const fromSquare = m.uci.slice(0, 2);
      const piece = chess.get(fromSquare);
      pieceCache[m.uci] = piece ? piece.type : undefined;
    }

    filtered.sort((a, b) => {
      const pieceA = pieceCache[a.uci];
      const pieceB = pieceCache[b.uci];
      if (pieceA !== pieceB) {
        return (order[pieceA] ?? 99) - (order[pieceB] ?? 99);
      }
      return (toWhiteRelativeEval(b.evalCp || 0, fen)) - (toWhiteRelativeEval(a.evalCp || 0, fen));
    });
  }
  // default 'eval' is already sorted

  renderMovesTable(filtered, fen);
}

// ── Bind all UI events ──
function bindUI() {
  document.getElementById('flipBtn').addEventListener('click', () => {
    board.flip();
    boardFlipped = !boardFlipped;
    // Re-render any active overlays with new orientation
    if (allMovesResult.length > 0) renderBoardBadges(allMovesResult, allMovesResultFen || game.fen());
    // Re-project square highlights with new orientation
    if (lastHighlight) {
      highlightLastMove(lastHighlight.from, lastHighlight.to, lastHighlight.category);
    }
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    game.reset();
    board.start();
    renderMoves();
    updateEvalBar(0);
    clearBoardBadges();
    clearSquareHighlights();
  });

  document.getElementById('undoBtn').addEventListener('click', () => {
    game.undo();
    board.position(game.fen());
    renderMoves();
    clearBoardBadges();
    clearSquareHighlights();
  });

  document.getElementById('loadFenBtn').addEventListener('click', () => {
    const fen = el.fenInput.value.trim();
    if (!fen) return;
    if (!game.load(fen)) {
      el.fenInput.style.borderColor = 'var(--mistake)';
      setTimeout(() => { el.fenInput.style.borderColor = ''; }, 1500);
      return;
    }
    board.position(game.fen());
    renderMoves();
    clearBoardBadges();
    clearSquareHighlights();
    // Clear explorer UI state so no stale results remain after FEN change.
    if (typeof el.pieceBadges !== 'undefined' && el.pieceBadges && el.pieceBadges.innerHTML !== undefined) {
      el.pieceBadges.innerHTML = '';
    }
    if (typeof el.allMovesTable !== 'undefined' && el.allMovesTable && el.allMovesTable.innerHTML !== undefined) {
      el.allMovesTable.innerHTML = '';
    }
    if (typeof el.explorerFilters !== 'undefined' && el.explorerFilters && el.explorerFilters.style) {
      el.explorerFilters.style.display = 'none';
    }
    if (typeof el.explorerProgress !== 'undefined' && el.explorerProgress && el.explorerProgress.style) {
      el.explorerProgress.style.display = 'none';
    }
    allMovesResult = [];
    allMovesResultFen = null;
  });

  document.getElementById('copyFenBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(game.fen()).catch(() => {});
    const btn = document.getElementById('copyFenBtn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1000);
  });

  document.getElementById('analyzePositionBtn').addEventListener('click', analyzePosition);
  document.getElementById('analyzeAllMovesBtn').addEventListener('click', runAllMoves);
  document.getElementById('analyzeGameBtn').addEventListener('click', analyzeGame);
  document.getElementById('openingBtn').addEventListener('click', detectOpening);

  // Game review navigation
  document.getElementById('navFirst').addEventListener('click', () => navigateToGamePly(0));
  document.getElementById('navPrev').addEventListener('click', () => navigateToGamePly(Math.max(0, gameReviewPly - 1)));
  document.getElementById('navNext').addEventListener('click', () => {
    if (gameReviewData) navigateToGamePly(Math.min(gameReviewData.plies.length - 1, gameReviewPly + 1));
  });
  document.getElementById('navLast').addEventListener('click', () => {
    if (gameReviewData) navigateToGamePly(gameReviewData.plies.length - 1);
  });

  // Explorer filters
  el.filterPiece.addEventListener('change', applyExplorerFilters);
  el.sortMoves.addEventListener('change', applyExplorerFilters);

  // Keyboard navigation for game review
  document.addEventListener('keydown', (e) => {
    if (!gameReviewData) return;
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateToGamePly(Math.max(0, gameReviewPly - 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      navigateToGamePly(Math.min(gameReviewData.plies.length - 1, gameReviewPly + 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      navigateToGamePly(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      navigateToGamePly(gameReviewData.plies.length - 1);
    }
  });

  // Eval graph click to navigate
  el.evalGraph.addEventListener('click', (e) => {
    if (!gameReviewData) return;
    const rect = el.evalGraph.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ply = Math.round((x / rect.width) * (gameReviewData.plies.length - 1));
    navigateToGamePly(Math.max(0, Math.min(gameReviewData.plies.length - 1, ply)));
  });
}

// ── Initialize ──
board = window.Chessboard('board', {
  draggable: true,
  position: 'start',
  pieceTheme: 'https://unpkg.com/@chrisoakman/chessboardjs@1.0.0/www/img/chesspieces/wikipedia/{piece}.png',
  onDrop,
  onSnapEnd
});

initTabs();
bindUI();
renderMoves();
updateEvalBar(0);
