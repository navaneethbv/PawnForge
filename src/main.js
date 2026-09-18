import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.1.0/+esm';

// ── State ──
let game = new Chess();
let board;
let allMovesResult = [];
let allMovesResultFen = null;
let gameReviewData = null;
let gameReviewPly = -1;
let gameReviewFens = [];
let gameReviewPreFens = [];
let gameReviewRequestId = 0;
let gameReviewController = null;
let gameReviewHistory = [];

// ── Piece symbol map (for display) ──
const PIECE_SYMBOLS = { p: '', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };
const PIECE_UNICODE = {
  wp: '\u2659', wn: '\u2658', wb: '\u2657', wr: '\u2656', wq: '\u2655', wk: '\u2654',
  bp: '\u265F', bn: '\u265E', bb: '\u265D', br: '\u265C', bq: '\u265B', bk: '\u265A'
};
const PIECE_THEME = Object.fromEntries(Object.entries(PIECE_UNICODE).map(([key, glyph]) => {
  const isWhite = key[0] === 'w';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
    <text x="40" y="62" text-anchor="middle" font-family="Georgia, serif" font-size="64"
      fill="${isWhite ? '#f8fafc' : '#111827'}" stroke="${isWhite ? '#111827' : '#f8fafc'}"
      stroke-width="${isWhite ? '1.5' : '1'}" paint-order="stroke">${glyph}</text>
  </svg>`;
  return [`${key[0]}${key[1].toUpperCase()}`, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`];
}));

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
  sortMoves: document.getElementById('sortMoves'),
  boardArrowOverlay: document.getElementById('boardArrowOverlay'),
  coachToggle: document.getElementById('coachToggle'),
  coachCard: document.getElementById('coachCard'),
  coachStatusText: document.getElementById('coachStatusText'),
  coachMoveDetail: document.getElementById('coachMoveDetail'),
  applyCoachMoveBtn: document.getElementById('applyCoachMoveBtn'),
  coachCandidates: document.getElementById('coachCandidates'),
  sparringToggle: document.getElementById('sparringToggle'),
  sparringColor: document.getElementById('sparringColor'),
  sparringLevel: document.getElementById('sparringLevel'),
  soundToggleBtn: document.getElementById('soundToggleBtn'),
  moveNavStart: document.getElementById('moveNavStart'),
  moveNavPrev: document.getElementById('moveNavPrev'),
  moveNavNext: document.getElementById('moveNavNext'),
  moveNavEnd: document.getElementById('moveNavEnd')
};

// ── Board orientation tracking ──
let boardFlipped = false;
let lastHighlight = null; // { from, to, category }
let positionAnalysisRequestId = 0;
let explorerRequestId = 0;
let activeExplorerStream = null;

// ── Zero-Dependency Web Audio Synthesis ──
let audioContext = null;
let soundEnabled = true;

function playChessSound(type = 'move') {
  if (!soundEnabled) return;
  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);
    const now = audioContext.currentTime;

    if (type === 'capture') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(45, now + 0.12);
      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === 'check') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.setValueAtTime(880, now + 0.08);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.start(now);
      osc.stop(now + 0.28);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.exponentialRampToValueAtTime(70, now + 0.06);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.start(now);
      osc.stop(now + 0.06);
    }
  } catch (_e) {}
}

// ── Move History Tracking & Interactive Navigation ──
let initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let playedMoves = []; // { from, to, promotion, san }
let currentMoveIndex = -1; // -1 = initial position

function recordPlayedMove(move) {
  if (!move) return;
  if (currentMoveIndex < playedMoves.length - 1) {
    playedMoves = playedMoves.slice(0, currentMoveIndex + 1);
  }
  playedMoves.push({ from: move.from, to: move.to, promotion: move.promotion, san: move.san });
  currentMoveIndex = playedMoves.length - 1;
}

function updateActiveMoveHighlight() {
  document.querySelectorAll('#moveList .move-san').forEach((span) => {
    const ply = parseInt(span.dataset.ply, 10);
    if (ply === currentMoveIndex) {
      span.classList.add('active');
    } else {
      span.classList.remove('active');
    }
  });
}

function jumpToHistoryPly(ply) {
  if (playedMoves.length === 0 && ply >= 0) return;
  if (ply < -1) ply = -1;
  if (ply >= playedMoves.length) ply = playedMoves.length - 1;
  currentMoveIndex = ply;

  const replay = new Chess(initialFen);
  for (let i = 0; i <= ply; i++) {
    replay.move(playedMoves[i]);
  }
  game = replay;
  board.position(replay.fen());
  el.fenInput.value = replay.fen();
  clearPositionAnalysis();

  clearExplorerUI();
  updateActiveMoveHighlight();
  clearBoardBadges();
  clearSquareHighlights();
  if (ply >= 0 && playedMoves[ply]) {
    highlightLastMove(playedMoves[ply].from, playedMoves[ply].to, 'good');
  }
  updateCoachHint();
}

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

function clearPositionAnalysis() {
  coachReqId += 1;
  currentCoachMove = null;
  coachCandidates = [];
  el.coachCandidates.innerHTML = '';
  el.applyCoachMoveBtn.style.display = 'none';
  clearMoveArrow();
  invalidateSparring();
  positionAnalysisRequestId += 1;
  el.topMovesContainer.innerHTML = '<div class="placeholder-text">Position changed. Analyze again for current engine lines.</div>';
  el.pvLines.innerHTML = '';
  updateEvalBar(0);
  setEngineStatus('Position changed', 'idle');
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

// ── SVG Move Arrow (Coach Mode) ──
function squareToCenterCoords(sq) {
  const file = sq.charCodeAt(0) - 97; // a=0, h=7
  const rank = parseInt(sq[1]) - 1;   // 1=0, 8=7
  if (boardFlipped) {
    return { x: (7 - file) * 12.5 + 6.25, y: rank * 12.5 + 6.25 };
  }
  return { x: file * 12.5 + 6.25, y: (7 - rank) * 12.5 + 6.25 };
}

function renderMoveArrow(from, to, rank = 1) {
  if (!from || !to || !el.boardArrowOverlay) return;
  const start = squareToCenterCoords(from);
  const end = squareToCenterCoords(to);

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return;
  const shorten = 3.2; // Shorten slightly so arrowhead aligns cleanly in square center
  const targetX = end.x - (dx / dist) * shorten;
  const targetY = end.y - (dy / dist) * shorten;

  if (rank === 1) {
    // 1. Origin square pointer (primary move)
    const originCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    originCircle.setAttribute('cx', start.x);
    originCircle.setAttribute('cy', start.y);
    originCircle.setAttribute('r', '4.5');
    originCircle.setAttribute('class', 'coach-origin-pointer');
    el.boardArrowOverlay.appendChild(originCircle);

    const originDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    originDot.setAttribute('cx', start.x);
    originDot.setAttribute('cy', start.y);
    originDot.setAttribute('r', '1.3');
    originDot.setAttribute('fill', '#22c55e');
    el.boardArrowOverlay.appendChild(originDot);
  }

  // 2. Arrow path from origin to destination
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M ${start.x} ${start.y} L ${targetX} ${targetY}`);
  const cls = rank === 1 ? 'coach-arrow-path' : (rank === 2 ? 'coach-arrow-path-secondary' : 'coach-arrow-path-tertiary');
  const marker = rank === 1 ? 'coachArrowHead' : (rank === 2 ? 'coachArrowHeadSecondary' : 'coachArrowHeadTertiary');
  path.setAttribute('class', cls);
  path.setAttribute('marker-end', `url(#${marker})`);
  el.boardArrowOverlay.appendChild(path);

  if (rank === 1) {
    // 3. Target square pointer
    const targetCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    targetCircle.setAttribute('cx', end.x);
    targetCircle.setAttribute('cy', end.y);
    targetCircle.setAttribute('r', '4.5');
    targetCircle.setAttribute('class', 'coach-target-pointer');
    el.boardArrowOverlay.appendChild(targetCircle);
  }
}

function clearMoveArrow() {
  if (!el.boardArrowOverlay) return;
  el.boardArrowOverlay.querySelectorAll('.coach-arrow-path, .coach-arrow-path-secondary, .coach-arrow-path-tertiary, .coach-origin-pointer, .coach-target-pointer, circle').forEach((p) => p.remove());
}

// ── Coach State & Multi-PV Analysis ──
let coachEnabled = false;
let currentCoachMove = null;
let coachCandidates = [];
let activeCandidateIdx = 0;
let coachReqId = 0;

async function updateCoachHint() {
  const thisReq = ++coachReqId;
  if (!coachEnabled) {
    clearMoveArrow();
    if (el.coachCard) el.coachCard.style.display = 'none';
    return;
  }

  if (game.isGameOver()) {
    clearMoveArrow();
    currentCoachMove = null;
    coachCandidates = [];
    if (el.coachCard) {
      el.coachCard.style.display = 'block';
      el.coachStatusText.textContent = 'Game Over';
      let outcome = 'Draw / Stalemate';
      if (game.isCheckmate()) {
        outcome = `Checkmate! ${game.turn() === 'w' ? 'Black' : 'White'} wins!`;
      }
      el.coachMoveDetail.textContent = outcome;
      el.applyCoachMoveBtn.style.display = 'none';
      if (el.coachCandidates) el.coachCandidates.innerHTML = '';
    }
    return;
  }

  currentCoachMove = null;
  clearMoveArrow();
  if (el.coachCard) {
    el.coachCard.style.display = 'block';
    el.coachStatusText.textContent = 'Coach: Calculating options...';
    el.coachMoveDetail.textContent = 'Stockfish 19 is evaluating candidate moves...';
    el.applyCoachMoveBtn.style.display = 'none';
  }

  try {
    const fen = game.fen();
    const data = await postJson('/api/analyze/position', {
      fen,
      settings: { depth: 10, multiPv: 3 }
    });

    if (thisReq !== coachReqId || !coachEnabled || fen !== game.fen()) return;

    if (!data.topMoves || data.topMoves.length === 0) {
      el.coachStatusText.textContent = 'Coach: No legal moves';
      el.coachMoveDetail.textContent = 'Position has no legal continuations.';
      clearMoveArrow();
      if (el.coachCandidates) el.coachCandidates.innerHTML = '';
      return;
    }

    coachCandidates = data.topMoves;
    activeCandidateIdx = 0;
    renderCoachCandidate(activeCandidateIdx);
  } catch (err) {
    if (thisReq === coachReqId && el.coachStatusText) {
      el.coachStatusText.textContent = 'Coach: Idle';
      el.coachMoveDetail.textContent = err.message || 'Could not calculate hint.';
    }
  }
}

function renderCoachCandidate(idx) {
  if (!coachCandidates || coachCandidates.length === 0) return;
  activeCandidateIdx = Math.max(0, Math.min(coachCandidates.length - 1, idx));
  const cand = coachCandidates[activeCandidateIdx];
  const fen = game.fen();

  const from = cand.uci.substring(0, 2);
  const to = cand.uci.substring(2, 4);
  const promo = cand.uci.length > 4 ? cand.uci[4] : undefined;

  const tmpGame = new Chess(fen);
  const pieceObj = tmpGame.get(from);
  const pieceNames = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
  const pieceName = pieceObj ? pieceNames[pieceObj.type] : 'Piece';
  const pieceIcon = pieceObj ? (PIECE_UNICODE[(pieceObj.color + pieceObj.type)] || '') : '';

  const mObj = tmpGame.move({ from, to, promotion: promo });
  const san = mObj ? mObj.san : cand.uci;

  currentCoachMove = { from, to, promotion: promo, san, uci: cand.uci, evalCp: cand.evalCp, pieceName, pieceIcon };

  // Render arrows: render secondary/tertiary first, then primary on top
  clearMoveArrow();
  coachCandidates.slice(0, 3).forEach((c, i) => {
    if (i !== activeCandidateIdx) {
      renderMoveArrow(c.uci.substring(0, 2), c.uci.substring(2, 4), i + 1);
    }
  });
  renderMoveArrow(from, to, 1);

  // Update coach card banner
  const whiteEval = toWhiteRelativeEval(cand.evalCp, fen);
  const turnName = fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  el.coachStatusText.textContent = `Coach: ${turnName} to Move`;
  el.coachMoveDetail.innerHTML = `
    <div class="coach-step-banner">
      <span>👉 Move <strong>${pieceIcon} ${pieceName}</strong> on <strong>${from.toUpperCase()}</strong> ➔ <strong>${to.toUpperCase()}</strong></span>
      <span class="coach-eval-tag" style="margin-left:auto;">${formatEval(whiteEval)}</span>
    </div>
    <div style="margin-top:0.4rem; color:var(--text); font-size:0.8rem;">
      Play <strong>${san}</strong> &bull; Line: <em>${cand.pv.split(' ').slice(0, 5).join(' ')}</em>
    </div>
  `;
  el.applyCoachMoveBtn.style.display = 'inline-block';

  // Render candidate pills
  if (el.coachCandidates) {
    el.coachCandidates.innerHTML = '';
    coachCandidates.slice(0, 3).forEach((c, i) => {
      const cFrom = c.uci.substring(0, 2);
      const cTo = c.uci.substring(2, 4);
      const cPromo = c.uci.length > 4 ? c.uci[4] : undefined;
      const cGame = new Chess(fen);
      const cMove = cGame.move({ from: cFrom, to: cTo, promotion: cPromo });
      const cSan = cMove ? cMove.san : c.uci;
      const cEval = toWhiteRelativeEval(c.evalCp, fen);

      const pill = document.createElement('button');
      pill.className = 'coach-candidate-pill' + (i === activeCandidateIdx ? ' active' : '');
      pill.innerHTML = `<span class="pill-rank">#${i + 1}</span> <strong>${cSan}</strong> <span class="coach-eval-tag">${formatEval(cEval)}</span>`;
      pill.addEventListener('click', () => {
        renderCoachCandidate(i);
      });
      el.coachCandidates.appendChild(pill);
    });
  }
}

function applyCoachMove() {
  if (!coachEnabled || !currentCoachMove) return;
  const move = game.move({
    from: currentCoachMove.from,
    to: currentCoachMove.to,
    promotion: currentCoachMove.promotion || 'q'
  });
  if (!move) return;
  recordPlayedMove(move);
  board.position(game.fen());
  renderMoves();
  clearPositionAnalysis();
  clearExplorerUI();
  clearBoardBadges();
  highlightLastMove(move.from, move.to, 'best');

  const sound = game.inCheck() ? 'check' : (move.captured ? 'capture' : 'move');
  playChessSound(sound);

  updateCoachHint();
  checkSparringTurn();
}

// ── Sparring Mode (Play vs Computer) ──
let sparringActive = false;
let sparringPlayerColor = 'w';
let isEngineThinking = false;
let sparringRequestId = 0;
let sparringController = null;
function invalidateSparring() {
  sparringRequestId += 1;
  sparringController?.abort();
  sparringController = null;
  isEngineThinking = false;
}

async function checkSparringTurn() {
  if (!sparringActive || isEngineThinking || game.isGameOver()) return;
  const currentTurn = game.turn();
  if (currentTurn !== sparringPlayerColor) {
    const requestId = ++sparringRequestId;
    const fen = game.fen();
    const playerColor = sparringPlayerColor;
    sparringController = new AbortController();
    isEngineThinking = true;
    setEngineStatus('Computer thinking...', 'active');
    try {
      const depth = Number(el.sparringLevel ? el.sparringLevel.value : 12);
      const res = await postJson('/api/analyze/position', {
        fen,
        settings: { depth, multiPv: 1 }
      }, sparringController.signal);
      if (requestId !== sparringRequestId || !sparringActive || playerColor !== sparringPlayerColor || game.fen() !== fen) return;
      if (res.topMoves && res.topMoves.length > 0) {
        const uci = res.topMoves[0].uci;
        const from = uci.substring(0, 2);
        const to = uci.substring(2, 4);
        const promo = uci[4];
        const moveObj = game.move({ from, to, promotion: promo || 'q' });
        if (moveObj) {
          recordPlayedMove(moveObj);
          board.position(game.fen());
          renderMoves();
          clearPositionAnalysis();
          clearExplorerUI();
          highlightLastMove(from, to, 'good');
          const sound = game.inCheck() ? 'check' : (moveObj.captured ? 'capture' : 'move');
          playChessSound(sound);
          updateEvalBar(toWhiteRelativeEval(res.bestEvalCp, fen));
          updateCoachHint();
        }
      }
    } catch (error) {
      if (requestId === sparringRequestId && error.name !== 'AbortError') setEngineStatus('Engine error', 'error');
    } finally {
      if (requestId === sparringRequestId) {
        isEngineThinking = false;
        sparringController = null;
        updateCoachHint();
      }
    }
  }
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

  const fields = initialFen.split(' ');
  const offset = fields[1] === 'b' ? 1 : 0;
  const firstNumber = Number(fields[5]);
  let pair;
  playedMoves.forEach((move, i) => {
    const black = (i + offset) % 2 === 1;
    if (!black || i === 0) {
      pair = document.createElement('div');
      pair.className = 'move-pair';
      const num = document.createElement('span');
      num.className = 'move-number';
      num.textContent = `${firstNumber + Math.floor((i + offset) / 2)}${black ? '...' : '.'}`;
      pair.appendChild(num);
      el.moveList.appendChild(pair);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'move-san' + (currentMoveIndex === i ? ' active' : '');
    button.textContent = move.san;
    button.dataset.ply = i;
    button.addEventListener('click', () => jumpToHistoryPly(i));
    pair.appendChild(button);
  });

  el.fenInput.value = game.fen();
}

// ── Board event handlers ──
function onDrop(source, target) {
  if (sparringActive && isEngineThinking) return 'snapback';
  if (sparringActive && game.turn() !== sparringPlayerColor) return 'snapback';

  let move;
  try { move = game.move({ from: source, to: target, promotion: 'q' }); }
  catch { return 'snapback'; }
  if (!move) return 'snapback';

  recordPlayedMove(move);
  renderMoves();
  clearPositionAnalysis();
  clearExplorerUI();
  clearBoardBadges();
  highlightLastMove(source, target, null);

  const sound = game.inCheck() ? 'check' : (move.captured ? 'capture' : 'move');
  playChessSound(sound);

  updateCoachHint();
  checkSparringTurn();
  return undefined;
}

function onSnapEnd() {
  board.position(game.fen());
}

// ── API helpers ──
async function postJson(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
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
  const requestId = ++positionAnalysisRequestId;
  const analysisFen = game.fen();
  setEngineStatus('Analyzing position...', 'active');
  try {
    const depth = Number(document.getElementById('depthSelect').value);
    const multiPv = Number(document.getElementById('multipvSelect').value);
    const data = await postJson('/api/analyze/position', {
      fen: analysisFen,
      settings: { depth, multiPv }
    });

    if (requestId !== positionAnalysisRequestId || game.fen() !== analysisFen) return;

    // Convert evals to White-relative for display
    const fen = analysisFen;

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
    if (requestId !== positionAnalysisRequestId || game.fen() !== analysisFen) return;
    el.topMovesContainer.textContent = `Error: ${error.message}`;
    setEngineStatus('Analysis failed', 'error');
  }
}

// ── SSE Polyfill for POST requests ──
class EventSourcePolyfill {
  constructor(url, { payload }) {
    this.ctrl = new AbortController();
    this.closed = false;
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
        while (!this.closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const chunks = buf.split('\n\n');
          buf = chunks.pop() || '';
          chunks.forEach((chunk) => {
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line && this.onmessage && !this.closed) this.onmessage({ data: line.slice(6) });
          });
        }
      })
      .catch((error) => {
        if (this.closed || error.name === 'AbortError') return;
        if (this.onerror) this.onerror(error);
      });
  }
  close() {
    this.closed = true;
    try { this.ctrl.abort(); } catch (_e) {}
  }
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

  // Use provided FEN or fall back to allMovesResultFen or current game FEN
  const fenToUse = fen || allMovesResultFen || game.fen();
  let html = '<table><thead><tr><th>#</th><th>Move</th><th>Eval</th><th>Delta</th><th>Quality</th></tr></thead><tbody>';
  moves.forEach((m, i) => {
    const cat = m.category || classify(m.deltaCp || 0);
    const whiteEval = toWhiteRelativeEval(m.evalCp, fenToUse);
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

// ── Clear explorer UI state ──
function clearExplorerUI() {
  explorerRequestId += 1;
  if (activeExplorerStream) {
    activeExplorerStream.close();
    activeExplorerStream = null;
  }
  el.pieceBadges.innerHTML = '';
  el.allMovesTable.innerHTML = '';
  el.explorerFilters.style.display = 'none';
  el.explorerProgress.style.display = 'none';
  allMovesResult = [];
  allMovesResultFen = null;
}

// ── All-moves explorer with streaming ──
function runAllMoves() {
  clearExplorerUI();
  setEngineStatus('Evaluating all legal moves...', 'active');
  el.explorerProgress.style.display = 'flex';
  el.explorerProgressFill.style.width = '0%';
  el.explorerProgressText.textContent = 'Starting...';

  const currentFen = game.fen();
  const requestId = explorerRequestId;

  const es = new EventSourcePolyfill('/api/analyze/all-moves', {
    payload: JSON.stringify({
      fen: currentFen,
      settings: { movetimeMs: Number(document.getElementById('movetimeSelect').value) }
    })
  });
  activeExplorerStream = es;

  const partial = [];
  es.onmessage = (event) => {
    if (requestId !== explorerRequestId || game.fen() !== currentFen) {
      es.close();
      return;
    }
    const data = JSON.parse(event.data);
    if (data.type === 'error') throw new Error(data.error);
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
      if (activeExplorerStream === es) activeExplorerStream = null;
    }
  };

  es.onerror = (error) => {
    if (requestId !== explorerRequestId) return;
    const msg = error && error.message ? error.message : 'Streaming failed';
    el.allMovesTable.textContent = `Error: ${msg}`;
    el.explorerProgress.style.display = 'none';
    setEngineStatus('Explorer failed', 'error');
    es.close();
    if (activeExplorerStream === es) activeExplorerStream = null;
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
    const moveNum = gameReviewPreFens[i]?.split(' ')[5] || Math.floor(i / 2) + 1;
    ctx.fillText(moveNum.toString(), x, h - 4);
  }
}

// ── Game analysis ──
async function analyzeGame() {
  const requestId = ++gameReviewRequestId;
  gameReviewController?.abort();
  gameReviewController = new AbortController();
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
    const initialFen = replay.header().FEN || undefined;
    const cursor = new Chess(initialFen);
    hist.forEach((mv) => {
      preMoveSequence.push(cursor.fen());
      cursor.move(mv);
      fenSequence.push(cursor.fen());
    });


    el.gameProgressText.textContent = `Analyzing ${hist.length} plies...`;
    el.gameProgressFill.style.width = '10%';

    const data = await postJson('/api/analyze/game', {
      pgn: el.pgnInput.value,
      moves: hist.map((m) => m.san),
      fenSequence,
      preMoveSequence,
      settings: { depth: Number(document.getElementById('gameDepthSelect').value) }
    }, gameReviewController.signal);
    if (requestId !== gameReviewRequestId) return;
    gameReviewFens = fenSequence;
    gameReviewPreFens = preMoveSequence;
    gameReviewHistory = hist;
    gameReviewPly = -1;

    gameReviewData = data;
    el.gameProgressFill.style.width = '100%';
    el.gameProgressText.textContent = 'Complete!';

    setTimeout(() => { if (requestId === gameReviewRequestId) el.gameProgress.style.display = 'none'; }, 1000);

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
    if (requestId !== gameReviewRequestId || error.name === 'AbortError') return;
    el.gameMoveList.textContent = `Error: ${error.message}`;
    el.gameProgress.style.display = 'none';
    setEngineStatus('Game analysis failed', 'error');
  }
}

function renderGameMoveList(data, hist) {
  el.gameMoveList.innerHTML = '';

  data.plies.forEach((p, i) => {
    const before = gameReviewPreFens[i].split(' ');
    if (before[1] === 'w' || i === 0) {
      const numSpan = document.createElement('span');
      numSpan.className = 'game-move-number';
      numSpan.textContent = `${before[5]}${before[1] === 'b' ? '...' : '.'}`;
      el.gameMoveList.appendChild(numSpan);
    }

    const moveEl = document.createElement('button');
    moveEl.type = 'button';
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
  initialFen = gameReviewPreFens[0];
  playedMoves = gameReviewHistory.map(({ from, to, promotion, san }) => ({ from, to, promotion, san }));
  currentMoveIndex = ply;
  game = new Chess(initialFen);
  for (let i = 0; i <= ply; i++) game.move(playedMoves[i]);
  board.position(fen);
  renderMoves();
  clearExplorerUI();
  el.fenInput.value = fen;
  clearPositionAnalysis();

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
    const side = hist[i].color === 'w' ? white : black;
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
  const fen = game.fen();
  try {
    setEngineStatus('Detecting opening...', 'active');
    const query = encodeURIComponent(game.history().join(' '));
    const res = await fetch(`/api/opening?moves=${query}`);
    if (!res.ok) throw new Error(`Failed (${res.status})`);
    const data = await res.json();
    if (game.fen() !== fen) return;

    el.openingResult.innerHTML = `
      <div class="opening-name">
        <span class="opening-eco">${data.eco}</span>
        ${data.name}
      </div>
      <div class="opening-meta">Book window: ply ${data.bookPlyRange[0]}-${data.bookPlyRange[1]}</div>
    `;

    el.openingContinuations.innerHTML = '';
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
          if (game.fen() !== fen) return;
          const m = game.move(c.move);
          if (m) {
            recordPlayedMove(m);
            board.position(game.fen());
            renderMoves();
            clearPositionAnalysis();
            clearExplorerUI();
            const sound = game.inCheck() ? 'check' : (m.captured ? 'capture' : 'move');
            playChessSound(sound);
            updateCoachHint();
            checkSparringTurn();
          }
        });
        el.openingContinuations.appendChild(row);
      });
    }

    setEngineStatus('Opening detected', 'idle');
  } catch (error) {
    el.openingResult.textContent = `Error: ${error.message}`;
    setEngineStatus('Opening detection failed', 'error');
  }
}

// ── Filter/sort for explorer ──
function applyExplorerFilters() {
  if (!allMovesResult || allMovesResult.length === 0) return;

  const fen = allMovesResultFen || game.fen();
  let filtered = [...allMovesResult];
  const filterVal = el.filterPiece.value;

  if (filterVal === 'captures') {
    filtered = filtered.filter((m) => m.flags && (m.flags.includes('c') || m.flags.includes('e')));
  } else if (filterVal === 'checks') {
    filtered = filtered.filter((m) => m.san && (m.san.includes('+') || m.san.includes('#')));
  }

  const sortVal = el.sortMoves.value;
  if (sortVal === 'delta') {
    filtered.sort((a, b) => (a.deltaCp || 0) - (b.deltaCp || 0));
  } else if (sortVal === 'piece') {
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
      return (b.evalCp || 0) - (a.evalCp || 0);
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
    if (coachEnabled && currentCoachMove) {
      renderMoveArrow(currentCoachMove.from, currentCoachMove.to);
    }
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    playedMoves = [];
    currentMoveIndex = -1;
    gameReviewRequestId += 1;
    gameReviewController?.abort();
    game.reset();
    board.start();
    renderMoves();
    clearPositionAnalysis();
    clearBoardBadges();
    clearSquareHighlights();
    clearExplorerUI();
    updateCoachHint();
    checkSparringTurn();
  });

  document.getElementById('undoBtn').addEventListener('click', () => {
    if (playedMoves.length > 0) {
      playedMoves = playedMoves.slice(0, Math.max(0, currentMoveIndex));
      jumpToHistoryPly(playedMoves.length - 1);
      renderMoves();
    } else {
      game.undo();
      board.position(game.fen());
      renderMoves();
      clearPositionAnalysis();
      clearBoardBadges();
      clearSquareHighlights();
      clearExplorerUI();
      updateCoachHint();
    }
  });

  document.getElementById('loadFenBtn').addEventListener('click', () => {
    const fen = el.fenInput.value.trim();
    if (!fen) return;
    let loaded = false;
    try {
      game.load(fen);
      loaded = true;
    } catch (_error) {
      loaded = false;
    }
    if (!loaded) {
      el.fenInput.style.borderColor = 'var(--mistake)';
      setTimeout(() => { el.fenInput.style.borderColor = ''; }, 1500);
      return;
    }
    initialFen = fen;
    playedMoves = [];
    currentMoveIndex = -1;
    board.position(game.fen());
    renderMoves();
    clearPositionAnalysis();
    clearBoardBadges();
    clearSquareHighlights();
    gameReviewRequestId += 1;
    gameReviewController?.abort();
    // Clear explorer UI state so no stale results remain after FEN change.
    clearExplorerUI();
    updateCoachHint();
    checkSparringTurn();
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

  // Move history navigation buttons
  if (el.moveNavStart) {
    el.moveNavStart.addEventListener('click', () => jumpToHistoryPly(-1));
  }
  if (el.moveNavPrev) {
    el.moveNavPrev.addEventListener('click', () => jumpToHistoryPly(currentMoveIndex - 1));
  }
  if (el.moveNavNext) {
    el.moveNavNext.addEventListener('click', () => jumpToHistoryPly(currentMoveIndex + 1));
  }
  if (el.moveNavEnd) {
    el.moveNavEnd.addEventListener('click', () => jumpToHistoryPly(playedMoves.length - 1));
  }

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

  // Global Keyboard Shortcuts (Coach, Move Play, Undo, Flip, Navigation)
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    // Toggle Coach: 'H'
    if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      if (el.coachToggle) {
        el.coachToggle.checked = !el.coachToggle.checked;
        el.coachToggle.dispatchEvent(new Event('change'));
      }
      return;
    }

    // Play Coach Move: Space
    if (e.code === 'Space' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      applyCoachMove();
      return;
    }

    // Flip Board: 'F'
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      const flipBtn = document.getElementById('flipBtn');
      if (flipBtn) flipBtn.click();
      return;
    }

    // Undo Move: 'Z'
    if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      e.preventDefault();
      const undoBtn = document.getElementById('undoBtn');
      if (undoBtn) undoBtn.click();
      return;
    }

    // Navigation: if in game review data, navigate review; else navigate main move history
    if (gameReviewData && document.getElementById('tab-game-review').classList.contains('active')) {
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
    } else {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        jumpToHistoryPly(currentMoveIndex - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        jumpToHistoryPly(currentMoveIndex + 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        jumpToHistoryPly(-1);
      } else if (e.key === 'End') {
        e.preventDefault();
        jumpToHistoryPly(playedMoves.length - 1);
      }
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

  // Window resize handler for board and eval graph
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (board && typeof board.resize === 'function') {
        board.resize();
      }
      if (gameReviewData && gameReviewData.plies) {
        drawEvalGraph(gameReviewData.plies, gameReviewPly);
      }
    }, 150);
  });

  // Coach mode toggle & Play Move button
  if (el.coachToggle) {
    el.coachToggle.checked = coachEnabled;
    el.coachToggle.addEventListener('change', (e) => {
      coachEnabled = e.target.checked;
      coachReqId += 1;
      currentCoachMove = null;
      try { localStorage.setItem('pawnforge_coach', coachEnabled ? 'true' : 'false'); } catch (_e) {}
      if (coachEnabled) {
        updateCoachHint();
      } else {
        clearMoveArrow();
        if (el.coachCard) el.coachCard.style.display = 'none';
      }
    });
  }

  if (el.applyCoachMoveBtn) {
    el.applyCoachMoveBtn.addEventListener('click', applyCoachMove);
  }

  // Sound toggle button
  if (el.soundToggleBtn) {
    el.soundToggleBtn.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      try { localStorage.setItem('pawnforge_sound', soundEnabled ? 'true' : 'false'); } catch (_e) {}
      el.soundToggleBtn.innerHTML = soundEnabled ? '&#128266;' : '&#128263;';
      el.soundToggleBtn.classList.toggle('muted', !soundEnabled);
      el.soundToggleBtn.title = soundEnabled ? 'Mute Sounds' : 'Unmute Sounds';
    });
  }

  // Sparring Mode controls
  if (el.sparringToggle) {
    el.sparringToggle.addEventListener('change', (e) => {
      invalidateSparring();
      sparringActive = e.target.checked;
      if (sparringActive) {
        sparringPlayerColor = el.sparringColor ? el.sparringColor.value : 'w';
        if (sparringPlayerColor === 'b' && !boardFlipped) {
          board.flip();
          boardFlipped = true;
        } else if (sparringPlayerColor === 'w' && boardFlipped) {
          board.flip();
          boardFlipped = false;
        }
        checkSparringTurn();
      }
    });
  }
  if (el.sparringColor) {
    el.sparringColor.addEventListener('change', (e) => {
      invalidateSparring();
      sparringPlayerColor = e.target.value;
      if (sparringPlayerColor === 'b' && !boardFlipped) {
        board.flip();
        boardFlipped = true;
      } else if (sparringPlayerColor === 'w' && boardFlipped) {
        board.flip();
        boardFlipped = false;
      }
      if (sparringActive) {
        checkSparringTurn();
      }
    });
  }
}

// ── Embed Mode & Query Param Configuration ──
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('embed') === 'true' || urlParams.get('embed') === '1') {
  document.body.classList.add('embed-mode');
}
if (urlParams.get('coach') === 'true' || urlParams.get('coach') === '1') {
  coachEnabled = true;
} else {
  try {
    coachEnabled = localStorage.getItem('pawnforge_coach') === 'true';
  } catch (_e) {}
}

// ── Initialize ──
try {
  const savedSound = localStorage.getItem('pawnforge_sound');
  if (savedSound !== null) soundEnabled = savedSound === 'true';
} catch (_e) {}
if (el.soundToggleBtn) {
  el.soundToggleBtn.innerHTML = soundEnabled ? '&#128266;' : '&#128263;';
  el.soundToggleBtn.classList.toggle('muted', !soundEnabled);
  el.soundToggleBtn.title = soundEnabled ? 'Mute Sounds' : 'Unmute Sounds';
}

board = window.Chessboard('board', {
  draggable: true,
  position: 'start',
  pieceTheme: (piece) => PIECE_THEME[piece],
  onDrop,
  onSnapEnd
});

initTabs();
bindUI();
renderMoves();
updateEvalBar(0);
if (coachEnabled) {
  updateCoachHint();
}
