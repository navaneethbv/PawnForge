import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.1.0/+esm';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Mirrors chess-analysis.js: mate in N is encoded as ±(MATE_SCORE - N).
const MATE_SCORE = 100000;
const MATE_THRESHOLD = MATE_SCORE - 1000;

// ── State ──
let game = new Chess();
let board;
let allMovesResult = [];
let allMovesResultFen = null;
let explorerPieceFilter = null;
let gameReviewData = null;
let gameReviewPly = -1;
let gameReviewFens = [];
let gameReviewPreFens = [];
let gameReviewRequestId = 0;
let gameReviewController = null;
let gameReviewHistory = [];

// ── Piece symbols ──
const PIECE_UNICODE = new Map(Object.entries({
  wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
  bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚'
}));
const PIECE_NAMES = new Map(Object.entries({ p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' }));

// Board pieces are drawn from Unicode glyphs: the solid glyph gives the body
// and, for White, the outline glyph on top supplies the interior detail.
const PIECE_THEME = new Map([...PIECE_UNICODE.keys()].map((key) => {
  const solid = PIECE_UNICODE.get(`b${key[1]}`);
  const outline = PIECE_UNICODE.get(`w${key[1]}`);
  const text = (glyph, attrs) => `<text x="40" y="66" text-anchor="middle" font-size="68" ${attrs}
    font-family="'DejaVu Sans', 'Segoe UI Symbol', 'Apple Symbols', 'Noto Sans Symbols 2', sans-serif">${glyph}︎</text>`;
  const body = key.startsWith('w')
    ? text(solid, 'fill="#fbfbfb" stroke="#1b1f27" stroke-width="3" stroke-linejoin="round" paint-order="stroke"') + text(outline, 'fill="#1b1f27"')
    : text(solid, 'fill="#1b1f27" stroke="#1b1f27" stroke-width="3" stroke-linejoin="round" paint-order="stroke"') + text(outline, 'fill="#5b6475" opacity="0.55"');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">${body}</svg>`;
  return [`${key[0]}${key[1].toUpperCase()}`, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`];
}));

// ── DOM Elements ──
const $ = (id) => document.getElementById(id);
const el = {
  fenInput: $('fenInput'),
  fenError: $('fenError'),
  pgnInput: $('pgnInput'),
  moveList: $('moveList'),
  status: $('engineStatus'),
  topMovesContainer: $('topMovesContainer'),
  pvLines: $('pvLines'),
  allMovesTable: $('allMovesTable'),
  pieceBadges: $('pieceBadges'),
  explorerEmpty: $('explorerEmpty'),
  evalBar: $('evalBar'),
  evalBarFill: $('evalBarFill'),
  evalBarLabel: $('evalBarLabel'),
  evalDisplay: $('evalDisplay'),
  wdlW: $('wdlW'),
  wdlD: $('wdlD'),
  wdlL: $('wdlL'),
  wdlBarW: $('wdlBarW'),
  wdlBarD: $('wdlBarD'),
  wdlBarL: $('wdlBarL'),
  boardContainer: document.querySelector('.board-container'),
  boardBadgeOverlay: $('boardBadgeOverlay'),
  boardSquareHighlights: $('boardSquareHighlights'),
  boardArrowOverlay: $('boardArrowOverlay'),
  evalGraph: $('evalGraph'),
  evalGraphContainer: $('evalGraphContainer'),
  gameMoveList: $('gameMoveList'),
  gameSummary: $('gameSummary'),
  gameSummaryContent: $('gameSummaryContent'),
  gameProgress: $('gameProgress'),
  gameProgressText: $('gameProgressText'),
  explorerProgress: $('explorerProgress'),
  explorerProgressFill: $('explorerProgressFill'),
  explorerProgressText: $('explorerProgressText'),
  explorerFilters: $('explorerFilters'),
  openingResult: $('openingResult'),
  openingContinuations: $('openingContinuations'),
  filterPiece: $('filterPiece'),
  sortMoves: $('sortMoves'),
  coachToggle: $('coachToggle'),
  coachCard: $('coachCard'),
  coachStatusText: $('coachStatusText'),
  coachMoveDetail: $('coachMoveDetail'),
  applyCoachMoveBtn: $('applyCoachMoveBtn'),
  coachCandidates: $('coachCandidates'),
  sparringToggle: $('sparringToggle'),
  sparringColor: $('sparringColor'),
  sparringLevel: $('sparringLevel'),
  soundToggleBtn: $('soundToggleBtn'),
  copyFenBtn: $('copyFenBtn'),
  moveNavStart: $('moveNavStart'),
  moveNavPrev: $('moveNavPrev'),
  moveNavNext: $('moveNavNext'),
  moveNavEnd: $('moveNavEnd')
};

// Small DOM builder used instead of HTML strings for dynamic content.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

function placeholder(text) {
  return h('div', { class: 'placeholder-text' }, text);
}

function errorBox(text) {
  return h('div', { class: 'error-text', role: 'alert' }, text);
}

// ── Board orientation & overlays ──
let boardFlipped = false;
let lastHighlight = null; // { from, to, category }
let currentEvalCp = 0;
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

function moveSound(move) {
  if (game.inCheck()) return 'check';
  return move.captured ? 'capture' : 'move';
}

// ── Move History Tracking & Interactive Navigation ──
let initialFen = START_FEN;
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

// Side to move after `ply` (-1 = the initial position) of the move history.
function turnAfterPly(ply) {
  const first = initialFen.split(' ')[1];
  if ((ply + 1) % 2 === 0) return first;
  return first === 'w' ? 'b' : 'w';
}

function updateActiveMoveHighlight() {
  el.moveList.querySelectorAll('.move-san').forEach((button) => {
    const active = Number(button.dataset.ply) === currentMoveIndex;
    button.classList.toggle('active', active);
    if (active) button.scrollIntoView({ block: 'nearest' });
  });
}

function jumpToHistoryPly(ply) {
  if (playedMoves.length === 0 && ply >= 0) return;
  ply = Math.max(-1, Math.min(playedMoves.length - 1, ply));
  currentMoveIndex = ply;

  const replay = new Chess(initialFen);
  const line = playedMoves.slice(0, ply + 1);
  line.forEach((move) => replay.move(move));
  game = replay;
  board.position(replay.fen());
  setFenInput(replay.fen());
  clearPositionAnalysis();
  clearExplorerUI();
  updateActiveMoveHighlight();
  clearSquareHighlights();
  const last = line.at(-1);
  if (last) highlightLastMove(last.from, last.to, null);
  updateCoachHint();
}

// Apply bookkeeping after `move` has been played on `game`.
function commitMove(move, { syncBoard = true } = {}) {
  recordPlayedMove(move);
  if (syncBoard) board.position(game.fen());
  renderMoves();
  clearPositionAnalysis();
  clearExplorerUI();
  highlightLastMove(move.from, move.to, null);
  playChessSound(moveSound(move));
  updateCoachHint();
  checkSparringTurn();
}

function playUci(uci) {
  if (sparringActive && (isEngineThinking || game.turn() !== sparringPlayerColor)) return null;
  let move = null;
  try {
    move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
  } catch (_e) {}
  if (move) commitMove(move);
  return move;
}

// ── Engine status ──
function setEngineStatus(text, state = 'idle') {
  el.status.replaceChildren(h('span', { class: 'dot' }), h('span', { class: 'engine-text' }, text));
  el.status.className = ['active', 'error'].includes(state) ? `engine-indicator ${state}` : 'engine-indicator';
}

// ── Evaluation formatting ──
function isMateScore(cp) {
  return Math.abs(cp) >= MATE_THRESHOLD;
}

function mateDistance(cp) {
  return MATE_SCORE - Math.abs(cp);
}

// Format a White-relative evaluation, e.g. "+0.35", "-1.20", "#3", "-#2".
function formatEval(cp) {
  if (isMateScore(cp)) {
    const n = mateDistance(cp);
    return `${cp > 0 ? '' : '-'}#${n || ''}`;
  }
  const val = (cp / 100).toFixed(2);
  return cp > 0 ? `+${val}` : val;
}

// ── Win/Draw/Loss from centipawns (estimated logistic model) ──
function cpToWDL(cp) {
  // Heuristic only: a logistic win curve with a draw band that narrows as the
  // evaluation grows.
  const K = -0.00368208;
  const winP = 1 / (1 + Math.exp(K * cp));
  const drawBase = Math.max(0, 0.5 - Math.abs(cp) / 1200);
  const w = Math.max(0, Math.min(1, winP - drawBase / 2));
  const l = Math.max(0, Math.min(1, (1 - winP) - drawBase / 2));
  const d = Math.max(0, 1 - w - l);
  return { w: w * 100, d: d * 100, l: l * 100 };
}

// ── Eval bar (expects White-relative cp) ──
function updateEvalBar(evalCp) {
  currentEvalCp = evalCp;
  const clamped = Math.max(-1000, Math.min(1000, evalCp));
  let whiteShare = 0.5 + (clamped / 1000) * 0.45;
  if (isMateScore(evalCp)) whiteShare = evalCp > 0 ? 1 : 0;
  el.evalBarFill.style.transform = `scaleY(${whiteShare.toFixed(4)})`;

  const whiteAhead = evalCp >= 0;
  el.evalBarLabel.textContent = isMateScore(evalCp)
    ? `M${mateDistance(evalCp) || ''}`
    : Math.abs(evalCp / 100).toFixed(1);
  // Show the label at the leading side's end of the bar.
  el.evalBarLabel.classList.toggle('at-top', whiteAhead === boardFlipped);
  el.evalBarLabel.classList.toggle('on-dark', !whiteAhead);

  el.evalDisplay.textContent = evalCp === 0 ? '0.00' : formatEval(evalCp);

  const wdl = cpToWDL(isMateScore(evalCp) ? Math.sign(evalCp) * 2000 : evalCp);
  el.wdlW.textContent = wdl.w.toFixed(1);
  el.wdlD.textContent = wdl.d.toFixed(1);
  el.wdlL.textContent = wdl.l.toFixed(1);
  el.wdlBarW.style.width = `${wdl.w}%`;
  el.wdlBarD.style.width = `${wdl.d}%`;
  el.wdlBarL.style.width = `${wdl.l}%`;
}

function clearPositionAnalysis() {
  coachReqId += 1;
  currentCoachMove = null;
  coachCandidates = [];
  el.coachCandidates.replaceChildren();
  el.applyCoachMoveBtn.hidden = true;
  clearMoveArrow();
  invalidateSparring();
  positionAnalysisRequestId += 1;
  el.topMovesContainer.replaceChildren(placeholder('Run an analysis to see the engine’s best lines for this position.'));
  el.pvLines.replaceChildren();
  updateEvalBar(0);
  setEngineStatus('Ready', 'idle');
}

// ── Board square coordinate helpers ──
function squareToPosition(sq) {
  const file = sq.charCodeAt(0) - 97; // a=0, h=7
  const rank = Number(sq[1]) - 1;     // 1=0, 8=7
  if (boardFlipped) return { left: (7 - file) * 12.5, top: rank * 12.5 };
  return { left: file * 12.5, top: (7 - rank) * 12.5 };
}

function squareToCenterCoords(sq) {
  const { left, top } = squareToPosition(sq);
  return { x: left + 6.25, y: top + 6.25 };
}

// The overlays must match the rendered board, which chessboard.js sizes to a
// whole number of pixels per square (often a little narrower than its parent).
function syncOverlaySize() {
  const inner = document.querySelector('#board .board-b72b1');
  if (inner) el.boardContainer.style.setProperty('--board-size', `${inner.offsetWidth}px`);
}

function setBoardFlipped(flipped) {
  if (flipped === boardFlipped) return;
  boardFlipped = flipped;
  board.orientation(flipped ? 'black' : 'white');
  el.evalBar.classList.toggle('flipped', flipped);
  updateEvalBar(currentEvalCp);
  if (allMovesResult.length > 0) renderBoardBadges(allMovesResult, allMovesResultFen);
  if (lastHighlight) highlightLastMove(lastHighlight.from, lastHighlight.to, lastHighlight.category);
  if (coachEnabled && coachCandidates.length > 0) renderCoachCandidate(activeCandidateIdx);
}

// ── On-board eval badges (best move per destination square) ──
function renderBoardBadges(moves, fen) {
  el.boardBadgeOverlay.replaceChildren();
  if (!moves || moves.length === 0) return;

  const bestByTarget = new Map();
  for (const m of moves) {
    const to = m.uci.substring(2, 4);
    const current = bestByTarget.get(to);
    if (!current || m.evalCp > current.evalCp) bestByTarget.set(to, m);
  }

  for (const [to, m] of bestByTarget) {
    const cat = m.category || classify(m.deltaCp || 0);
    const pos = squareToPosition(to);
    const whiteEval = toWhiteRelativeEval(m.evalCp, fen);
    const sign = whiteEval >= 0 ? '+' : '−';
    const text = isMateScore(whiteEval) ? formatEval(whiteEval) : `${sign}${Math.abs(whiteEval / 100).toFixed(1)}`;
    el.boardBadgeOverlay.appendChild(h('div', {
      class: `board-eval-badge cat-${cat.key}`,
      style: `left:${pos.left}%;top:${pos.top}%`
    }, h('span', { class: 'badge-label' }, text)));
  }
}

function clearBoardBadges() {
  el.boardBadgeOverlay.replaceChildren();
}

// ── Last-move square highlighting ──
function highlightLastMove(from, to, category) {
  lastHighlight = { from, to, category };
  const cls = category ? `highlight-${category}` : 'highlight-neutral';
  el.boardSquareHighlights.replaceChildren(...[from, to].map((sq) => {
    const pos = squareToPosition(sq);
    return h('div', { class: `board-square-highlight ${cls}`, style: `left:${pos.left}%;top:${pos.top}%` });
  }));
}

function clearSquareHighlights() {
  lastHighlight = null;
  el.boardSquareHighlights.replaceChildren();
}

// ── SVG Move Arrows (Coach Mode) ──
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

const ARROW_STYLES = [
  { cls: 'coach-arrow-path', marker: 'coachArrowHead' },
  { cls: 'coach-arrow-path-secondary', marker: 'coachArrowHeadSecondary' },
  { cls: 'coach-arrow-path-tertiary', marker: 'coachArrowHeadTertiary' }
];

function renderMoveArrow(from, to, rank = 1) {
  if (!from || !to) return;
  const start = squareToCenterCoords(from);
  const end = squareToCenterCoords(to);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return;
  const shorten = 3.2; // keep the arrowhead inside the target square
  const targetX = end.x - (dx / dist) * shorten;
  const targetY = end.y - (dy / dist) * shorten;

  if (rank === 1) {
    el.boardArrowOverlay.appendChild(svgEl('circle', { cx: start.x, cy: start.y, r: '4.5', class: 'coach-origin-pointer' }));
  }
  const { cls, marker } = ARROW_STYLES.at(Math.min(Math.max(rank, 1), ARROW_STYLES.length) - 1);
  el.boardArrowOverlay.appendChild(svgEl('path', {
    d: `M ${start.x} ${start.y} L ${targetX} ${targetY}`,
    class: cls,
    'marker-end': `url(#${marker})`
  }));
  if (rank === 1) {
    el.boardArrowOverlay.appendChild(svgEl('circle', { cx: end.x, cy: end.y, r: '4.5', class: 'coach-target-pointer' }));
  }
}

function clearMoveArrow() {
  el.boardArrowOverlay.querySelectorAll('path, circle').forEach((p) => p.remove());
}

// ── Coach State & Multi-PV Analysis ──
let coachEnabled = false;
let currentCoachMove = null;
let coachCandidates = [];
let activeCandidateIdx = 0;
let coachReqId = 0;

function showCoachMessage(title, detail) {
  clearMoveArrow();
  currentCoachMove = null;
  coachCandidates = [];
  el.coachCard.hidden = false;
  el.coachStatusText.textContent = title;
  el.coachMoveDetail.textContent = detail;
  el.applyCoachMoveBtn.hidden = true;
  el.coachCandidates.replaceChildren();
}

function gameOverText() {
  if (game.isCheckmate()) return `Checkmate — ${game.turn() === 'w' ? 'Black' : 'White'} wins.`;
  if (game.isStalemate()) return 'Stalemate — the game is drawn.';
  if (game.isThreefoldRepetition()) return 'Draw by threefold repetition.';
  if (game.isInsufficientMaterial()) return 'Draw by insufficient material.';
  return 'Draw by the fifty-move rule.';
}

async function updateCoachHint() {
  const thisReq = ++coachReqId;
  if (!coachEnabled) {
    clearMoveArrow();
    el.coachCard.hidden = true;
    return;
  }

  if (game.isGameOver()) {
    showCoachMessage('Game over', gameOverText());
    return;
  }

  if (sparringActive && game.turn() !== sparringPlayerColor) {
    showCoachMessage('Engine to move', 'Hints resume on your turn.');
    return;
  }

  showCoachMessage('Thinking…', 'Stockfish is evaluating candidate moves…');

  try {
    const fen = game.fen();
    const data = await postJson('/api/analyze/position', { fen, settings: { depth: 10, multiPv: 3 } });
    if (thisReq !== coachReqId || !coachEnabled || fen !== game.fen()) return;

    if (!data.topMoves || data.topMoves.length === 0) {
      showCoachMessage('No legal moves', 'This position has no legal continuations.');
      return;
    }

    coachCandidates = data.topMoves;
    renderCoachCandidate(0);
  } catch (err) {
    if (thisReq === coachReqId) showCoachMessage('Coach unavailable', err.message || 'Could not calculate a hint.');
  }
}

function sanForUci(fen, uci) {
  try {
    const move = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return move ? move.san : uci;
  } catch (_e) {
    return uci;
  }
}

// Convert a UCI principal variation to numbered SAN, e.g. "12. Nf3 Nc6 13. Bb5".
function pvToSan(fen, pv, maxPlies = Infinity) {
  const replay = new Chess(fen);
  const parts = [];
  for (const uci of pv.split(' ').slice(0, maxPlies)) {
    const fields = replay.fen().split(' ');
    let move;
    try { move = replay.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch (_e) { break; }
    if (!move) break;
    let number = null;
    if (fields[1] === 'w') number = `${fields[5]}.`;
    else if (parts.length === 0) number = `${fields[5]}...`;
    parts.push({ number, san: move.san });
  }
  return parts;
}

function renderCoachCandidate(idx) {
  if (!coachCandidates || coachCandidates.length === 0) return;
  activeCandidateIdx = Math.max(0, Math.min(coachCandidates.length - 1, idx));
  const cand = coachCandidates.at(activeCandidateIdx);
  const fen = game.fen();

  const from = cand.uci.substring(0, 2);
  const to = cand.uci.substring(2, 4);
  const promo = cand.uci.length > 4 ? cand.uci[4] : undefined;
  const piece = new Chess(fen).get(from);
  const pieceName = piece ? PIECE_NAMES.get(piece.type) : 'Piece';
  const pieceIcon = piece ? PIECE_UNICODE.get(piece.color + piece.type) : '';
  const san = sanForUci(fen, cand.uci);

  currentCoachMove = { from, to, promotion: promo, san, uci: cand.uci, evalCp: cand.evalCp };

  // Draw the alternative arrows first so the selected one is on top.
  clearMoveArrow();
  coachCandidates.slice(0, 3).forEach((c, i) => {
    if (i !== activeCandidateIdx) renderMoveArrow(c.uci.substring(0, 2), c.uci.substring(2, 4), i + 1);
  });
  renderMoveArrow(from, to, 1);

  const whiteEval = toWhiteRelativeEval(cand.evalCp, fen);
  const line = pvToSan(fen, cand.pv, 6).map((p) => (p.number ? `${p.number} ${p.san}` : p.san)).join(' ');
  el.coachStatusText.textContent = `${fen.split(' ')[1] === 'w' ? 'White' : 'Black'} to move`;
  el.coachMoveDetail.replaceChildren(
    h('div', { class: 'coach-step' },
      h('span', {}, `${pieceIcon} ${pieceName} `, h('strong', {}, from), ' → ', h('strong', {}, to), ` (${san})`),
      h('span', { class: 'coach-eval-tag' }, formatEval(whiteEval))),
    h('div', { class: 'coach-line' }, line)
  );
  el.applyCoachMoveBtn.hidden = false;

  el.coachCandidates.replaceChildren(...coachCandidates.slice(0, 3).map((c, i) => h('button', {
    type: 'button',
    class: 'coach-candidate-pill' + (i === activeCandidateIdx ? ' active' : ''),
    'aria-pressed': String(i === activeCandidateIdx),
    onclick: () => renderCoachCandidate(i)
  },
  h('span', { class: 'pill-rank' }, `#${i + 1}`),
  h('strong', {}, sanForUci(fen, c.uci)),
  h('span', { class: 'coach-eval-tag' }, formatEval(toWhiteRelativeEval(c.evalCp, fen))))));
}

function applyCoachMove() {
  if (!coachEnabled || !currentCoachMove) return;
  playUci(currentCoachMove.uci);
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

function applySparringResult(res, fen) {
  if (!res.topMoves?.length) return;
  const uci = res.topMoves[0].uci;
  let move = null;
  try { move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }); } catch (_e) {}
  if (!move) return;
  commitMove(move);
  updateEvalBar(toWhiteRelativeEval(res.bestEvalCp, fen));
}

async function checkSparringTurn() {
  if (!sparringActive || isEngineThinking || game.isGameOver()) return;
  if (game.turn() === sparringPlayerColor) return;
  const requestId = ++sparringRequestId;
  const fen = game.fen();
  const playerColor = sparringPlayerColor;
  sparringController = new AbortController();
  isEngineThinking = true;
  setEngineStatus('Engine is thinking…', 'active');
  try {
    const depth = Number(el.sparringLevel.value);
    const res = await postJson('/api/analyze/position', { fen, settings: { depth, multiPv: 1 } }, sparringController.signal);
    if (requestId !== sparringRequestId || !sparringActive || playerColor !== sparringPlayerColor || game.fen() !== fen) return;
    applySparringResult(res, fen);
    setEngineStatus('Your move', 'idle');
  } catch (error) {
    if (requestId === sparringRequestId && error.name !== 'AbortError') setEngineStatus(`Engine error: ${error.message}`, 'error');
  } finally {
    if (requestId === sparringRequestId) {
      isEngineThinking = false;
      sparringController = null;
      updateCoachHint();
    }
  }
}

function orientForSparring() {
  setBoardFlipped(sparringPlayerColor === 'b');
}

// ── Tab switching ──
function activateTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-content').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  // The graph canvas has no size while its tab is hidden, so redraw it now.
  if (name === 'game-review' && gameReviewData) drawEvalGraph(gameReviewData.plies, gameReviewPly);
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
}

// ── Move list rendering ──
function setFenInput(fen) {
  el.fenInput.value = fen;
  el.fenInput.removeAttribute('aria-invalid');
  el.fenError.hidden = true;
}

function renderMoves() {
  const fields = initialFen.split(' ');
  const offset = fields[1] === 'b' ? 1 : 0;
  const firstNumber = Number(fields[5]) || 1;
  const rows = [];
  let pair;
  playedMoves.forEach((move, i) => {
    const black = (i + offset) % 2 === 1;
    if (!black || i === 0) {
      pair = h('div', { class: 'move-pair' + (black ? ' starts-black' : '') },
        h('span', { class: 'move-number' }, `${firstNumber + Math.floor((i + offset) / 2)}${black ? '...' : '.'}`));
      rows.push(pair);
    }
    pair.appendChild(h('button', {
      type: 'button',
      class: 'move-san' + (currentMoveIndex === i ? ' active' : ''),
      dataset: { ply: String(i) },
      onclick: () => jumpToHistoryPly(i)
    }, move.san));
  });
  el.moveList.replaceChildren(...rows);
  updateActiveMoveHighlight();
  setFenInput(game.fen());
}

// ── Board event handlers ──
function onDragStart(_source, piece) {
  if (game.isGameOver()) return false;
  if (sparringActive && (isEngineThinking || game.turn() !== sparringPlayerColor)) return false;
  // Only allow the side to move to pick up pieces.
  return piece[0] === game.turn();
}

function onDrop(source, target) {
  if (sparringActive && (isEngineThinking || game.turn() !== sparringPlayerColor)) return 'snapback';

  let move;
  try { move = game.move({ from: source, to: target, promotion: 'q' }); }
  catch { return 'snapback'; }
  if (!move) return 'snapback';

  commitMove(move, { syncBoard: false });
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
  let json = null;
  try { json = await res.json(); } catch (_e) {}
  if (!res.ok) throw new Error(json?.error || `Request failed (HTTP ${res.status})`);
  if (!json) throw new Error('The server returned an invalid response.');
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
  return fen.split(' ')[1] === 'b' ? -evalCp : evalCp;
}

function evalPill(whiteEval, extraClass = '') {
  return h('span', { class: `pv-eval ${whiteEval >= 0 ? 'white-advantage' : 'black-advantage'} ${extraClass}`.trim() }, formatEval(whiteEval));
}

// ── Position Analysis ──
async function analyzePosition() {
  const requestId = ++positionAnalysisRequestId;
  const fen = game.fen();
  const depth = Number($('depthSelect').value);
  const multiPv = Number($('multipvSelect').value);
  setEngineStatus('Analyzing position…', 'active');
  el.topMovesContainer.replaceChildren(placeholder(`Analyzing to depth ${depth}…`));
  el.pvLines.replaceChildren();
  try {
    const data = await postJson('/api/analyze/position', { fen, settings: { depth, multiPv } });
    if (requestId !== positionAnalysisRequestId || game.fen() !== fen) return;

    if (!data.topMoves || data.topMoves.length === 0) {
      updateEvalBar(toWhiteRelativeEval(data.bestEvalCp ?? 0, fen));
      el.topMovesContainer.replaceChildren(placeholder(game.isGameOver() ? gameOverText() : 'The engine found no legal moves.'));
      setEngineStatus('Analysis complete', 'idle');
      return;
    }

    updateEvalBar(toWhiteRelativeEval(data.bestEvalCp, fen));
    el.topMovesContainer.replaceChildren(h('div', { class: 'top-moves-summary' },
      data.topMoves.map((m) => h('span', { class: 'top-move-chip' },
        sanForUci(fen, m.uci), evalPill(toWhiteRelativeEval(m.evalCp, fen))))));

    el.pvLines.replaceChildren(...data.topMoves.map((m, i) => {
      const parts = pvToSan(fen, m.pv);
      return h('button', {
        type: 'button',
        class: 'pv-line',
        title: 'Play the first move of this line',
        onclick: () => playUci(m.uci)
      },
      h('span', { class: 'pv-rank' }, `${i + 1}`),
      evalPill(toWhiteRelativeEval(m.evalCp, fen)),
      h('span', { class: 'pv-moves' }, parts.flatMap((p, j) => [
        p.number ? h('span', { class: 'pv-num' }, `${p.number} `) : null,
        h('span', { class: j === 0 ? 'pv-first' : null }, p.san),
        ' '
      ])));
    }));

    setEngineStatus(`Analysis complete · depth ${depth}`, 'idle');
  } catch (error) {
    if (requestId !== positionAnalysisRequestId || game.fen() !== fen) return;
    el.topMovesContainer.replaceChildren(errorBox(error.message));
    setEngineStatus('Analysis failed', 'error');
  }
}

// ── SSE client for POST requests ──
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
        const contentType = res.headers.get('content-type') || '';
        if (!res.ok || !contentType.includes('text/event-stream')) {
          let message = `Request failed (HTTP ${res.status})`;
          try { message = (await res.json()).error || message; } catch (_e) {}
          throw new Error(message);
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
          for (const chunk of chunks) {
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line && this.onmessage && !this.closed) this.onmessage({ data: line.slice(6) });
          }
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

function pieceKeyForMove(fen, uciMove) {
  const piece = new Chess(fen).get(uciMove.substring(0, 2));
  return piece ? `${piece.color}${piece.type}` : 'wp';
}

// ── Render piece badges for all-moves explorer ──
function renderPieceBadges(moves, fen) {
  el.pieceBadges.replaceChildren();
  if (!moves || moves.length === 0) return;

  const byPiece = new Map();
  for (const m of moves) {
    if (!byPiece.has(m.pieceKey)) byPiece.set(m.pieceKey, []);
    byPiece.get(m.pieceKey).push(m);
  }

  const order = ['k', 'q', 'r', 'b', 'n', 'p'];
  const sortedKeys = [...byPiece.keys()].sort((a, b) => order.indexOf(a[1]) - order.indexOf(b[1]));

  el.pieceBadges.replaceChildren(...sortedKeys.map((key) => {
    const pieceMoves = byPiece.get(key);
    const best = pieceMoves[0]; // moves arrive sorted by evaluation
    const cat = best.category || classify(best.deltaCp || 0);
    return h('button', {
      type: 'button',
      class: `piece-badge cat-${cat.key}` + (explorerPieceFilter === key ? ' selected' : ''),
      'aria-pressed': String(explorerPieceFilter === key),
      title: `Show only ${PIECE_NAMES.get(key[1]).toLowerCase()} moves`,
      onclick: () => {
        explorerPieceFilter = explorerPieceFilter === key ? null : key;
        el.pieceBadges.querySelectorAll('.piece-badge').forEach((b, i) => {
          const selected = sortedKeys.at(i) === explorerPieceFilter;
          b.classList.toggle('selected', selected);
          b.setAttribute('aria-pressed', String(selected));
        });
        applyExplorerFilters();
      }
    },
    h('span', { class: 'piece-icon', 'aria-hidden': 'true' }, PIECE_UNICODE.get(key)),
    h('span', { class: 'piece-best-move' }, best.san || best.uci),
    h('span', { class: 'piece-eval' }, `${formatEval(toWhiteRelativeEval(best.evalCp, fen))} · ${cat.label}`),
    h('span', { class: 'piece-count' }, `${pieceMoves.length} move${pieceMoves.length === 1 ? '' : 's'}`));
  }));
}

// ── Render all-moves table ──
function renderMovesTable(moves, fen) {
  if (!moves || moves.length === 0) {
    el.allMovesTable.replaceChildren(placeholder('No moves match the current filters.'));
    return;
  }

  el.allMovesTable.replaceChildren(h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, '#'), h('th', {}, 'Move'), h('th', { class: 'num' }, 'Eval'),
      h('th', { class: 'num' }, 'Loss'), h('th', {}, 'Quality'))),
    h('tbody', {}, moves.map((m) => {
      const cat = m.category || classify(m.deltaCp || 0);
      return h('tr', {},
        h('td', { class: 'rank' }, String(m.rank)),
        h('td', { class: 'move-cell' }, m.san || m.uci),
        h('td', { class: 'num' }, formatEval(toWhiteRelativeEval(m.evalCp, fen))),
        h('td', { class: 'num' }, m.deltaCp !== undefined ? (m.deltaCp / 100).toFixed(2) : '–'),
        h('td', {}, h('span', { class: `eval-badge ${cat.key}` }, cat.label)));
    }))));
}

// ── Clear explorer UI state ──
function clearExplorerUI() {
  explorerRequestId += 1;
  if (activeExplorerStream) {
    activeExplorerStream.close();
    activeExplorerStream = null;
  }
  el.pieceBadges.replaceChildren();
  el.allMovesTable.replaceChildren();
  clearBoardBadges();
  el.explorerFilters.hidden = true;
  el.explorerProgress.hidden = true;
  el.explorerEmpty.hidden = false;
  allMovesResult = [];
  allMovesResultFen = null;
  explorerPieceFilter = null;
}

// ── All-moves explorer with streaming ──
function runAllMoves() {
  clearExplorerUI();
  const currentFen = game.fen();
  if (game.isGameOver()) {
    el.allMovesTable.replaceChildren(placeholder(gameOverText()));
    el.explorerEmpty.hidden = true;
    return;
  }
  setEngineStatus('Evaluating all legal moves…', 'active');
  el.explorerEmpty.hidden = true;
  el.explorerProgress.hidden = false;
  el.explorerProgressFill.style.width = '0%';
  el.explorerProgressText.textContent = 'Starting…';

  const requestId = explorerRequestId;
  const total = game.moves().length;
  const es = new EventSourcePolyfill('/api/analyze/all-moves', {
    payload: JSON.stringify({
      fen: currentFen,
      settings: { movetimeMs: Number($('movetimeSelect').value) }
    })
  });
  activeExplorerStream = es;

  let evaluated = 0;
  es.onmessage = (event) => {
    if (requestId !== explorerRequestId || game.fen() !== currentFen) {
      es.close();
      return;
    }
    const data = JSON.parse(event.data);
    if (data.type === 'error') {
      es.onerror(new Error(data.error));
      return;
    }
    if (data.type === 'partial') {
      evaluated += 1;
      const pct = Math.round(data.progress * 100);
      el.explorerProgressFill.style.width = `${pct}%`;
      el.explorerProgressText.textContent = `${evaluated} / ${total} moves`;
    }

    if (data.type === 'final') {
      const tmpGame = new Chess(currentFen);
      allMovesResult = data.result.moves.map((m, i) => {
        const row = { ...m, rank: i + 1, san: m.uci, flags: '', pieceKey: pieceKeyForMove(currentFen, m.uci) };
        try {
          const moveObj = tmpGame.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
          if (moveObj) {
            row.san = moveObj.san;
            row.flags = moveObj.flags;
            tmpGame.undo();
          }
        } catch (_e) {
          // An engine move the local rules reject keeps its UCI label without SAN or flags.
        }
        return row;
      });
      allMovesResultFen = currentFen;

      renderPieceBadges(allMovesResult, currentFen);
      renderBoardBadges(allMovesResult, currentFen);
      el.explorerFilters.hidden = false;
      el.explorerProgress.hidden = true;
      applyExplorerFilters();
      setEngineStatus(`Explorer complete · ${allMovesResult.length} moves`, 'idle');
      es.close();
      if (activeExplorerStream === es) activeExplorerStream = null;
    }
  };

  es.onerror = (error) => {
    if (requestId !== explorerRequestId) return;
    el.allMovesTable.replaceChildren(errorBox(error?.message || 'Streaming failed'));
    el.explorerProgress.hidden = true;
    setEngineStatus('Explorer failed', 'error');
    es.close();
    if (activeExplorerStream === es) activeExplorerStream = null;
  };
}

// ── Eval graph drawing ──
function drawEvalGraph(plies, activePly = -1) {
  const canvas = el.evalGraph;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return; // hidden; redrawn when shown
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width;
  const height = rect.height;
  const pad = { top: 8, bottom: 22, left: 30, right: 8 };
  const gw = w - pad.left - pad.right;
  const gh = height - pad.top - pad.bottom;
  const midY = pad.top + gh / 2;
  ctx.clearRect(0, 0, w, height);
  if (!plies || plies.length === 0) return;

  const maxEval = 500; // ±5 pawns fills the graph
  const xAt = (i) => pad.left + (plies.length === 1 ? gw / 2 : (i * gw) / (plies.length - 1));
  const yAt = (p) => {
    const cp = toWhiteRelativeEval(p.evalCp, p.fen);
    const clamped = isMateScore(cp) ? Math.sign(cp) * maxEval : Math.max(-maxEval, Math.min(maxEval, cp));
    return midY - (clamped / maxEval) * (gh / 2);
  };

  // Black's share (background) and White's share (area below the curve).
  ctx.fillStyle = '#1f2633';
  ctx.fillRect(pad.left, pad.top, gw, gh);
  ctx.beginPath();
  ctx.moveTo(xAt(0), pad.top + gh);
  plies.forEach((p, i) => ctx.lineTo(xAt(i), yAt(p)));
  ctx.lineTo(xAt(plies.length - 1), pad.top + gh);
  ctx.closePath();
  ctx.fillStyle = 'rgba(238, 241, 245, 0.88)';
  ctx.fill();

  // Grid lines and axis labels.
  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const [value, label] of [[maxEval, '+5'], [0, '0'], [-maxEval, '−5']]) {
    const y = midY - (value / maxEval) * (gh / 2);
    ctx.strokeStyle = value === 0 ? 'rgba(239, 68, 68, 0.6)' : 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + gw, y);
    ctx.stroke();
    ctx.fillStyle = '#8490a3';
    ctx.fillText(label, pad.left - 6, y);
  }

  // Evaluation curve.
  ctx.beginPath();
  plies.forEach((p, i) => (i === 0 ? ctx.moveTo(xAt(i), yAt(p)) : ctx.lineTo(xAt(i), yAt(p))));
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.75;
  ctx.stroke();

  // Markers for inaccuracies, mistakes and blunders.
  const markerColors = { inaccuracy: '#f59e0b', mistake: '#f97316', blunder: '#ef4444' };
  plies.forEach((p, i) => {
    const color = markerColors[p.category?.key];
    if (!color) return;
    ctx.beginPath();
    ctx.arc(xAt(i), yAt(p), p.category.key === 'inaccuracy' ? 3 : 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#0e131c';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  // Active ply marker.
  if (activePly >= 0 && activePly < plies.length) {
    const x = xAt(activePly);
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + gh);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, yAt(plies.at(activePly)), 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Move numbers along the bottom, at White's plies only.
  ctx.fillStyle = '#8490a3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const fullMoves = Math.ceil(plies.length / 2);
  const every = Math.max(1, Math.ceil(fullMoves / Math.max(1, Math.floor(gw / 42))));
  let lastLabel = null;
  plies.forEach((_p, i) => {
    const fields = gameReviewPreFens.at(i)?.split(' ');
    const number = Number(fields?.[5] || Math.floor(i / 2) + 1);
    if (number === lastLabel || (number - 1) % every !== 0) return;
    lastLabel = number;
    ctx.fillText(String(number), xAt(i), height - 6);
  });
}

// ── Game analysis ──
async function analyzeGame() {
  const requestId = ++gameReviewRequestId;
  gameReviewController?.abort();
  gameReviewController = new AbortController();
  gameReviewData = null;
  gameReviewPly = -1;
  gameReviewFens = [];
  gameReviewPreFens = [];
  gameReviewHistory = [];
  el.gameSummary.hidden = true;
  el.evalGraphContainer.hidden = true;
  el.gameMoveList.hidden = true;
  el.gameMoveList.replaceChildren();
  try {
    let hist;
    let startFen;
    try {
      const replay = new Chess();
      replay.loadPgn(el.pgnInput.value, { strict: false });
      hist = replay.history({ verbose: true });
      startFen = replay.header().FEN || START_FEN;
    } catch (error) {
      throw new Error(`Could not read the PGN: ${error.message}`, { cause: error });
    }
    if (hist.length === 0) throw new Error('No moves found in the PGN.');

    const fenSequence = [];
    const preMoveSequence = [];
    const cursor = new Chess(startFen);
    hist.forEach((mv) => {
      preMoveSequence.push(cursor.fen());
      cursor.move(mv);
      fenSequence.push(cursor.fen());
    });

    setEngineStatus('Reviewing game…', 'active');
    el.gameProgress.hidden = false;
    el.gameProgressText.textContent = `Analyzing ${hist.length} plies…`;

    const data = await postJson('/api/analyze/game', {
      pgn: el.pgnInput.value,
      moves: hist.map((m) => m.san),
      fenSequence,
      preMoveSequence,
      settings: { depth: Number($('gameDepthSelect').value) }
    }, gameReviewController.signal);
    if (requestId !== gameReviewRequestId) return;
    gameReviewFens = fenSequence;
    gameReviewPreFens = preMoveSequence;
    gameReviewHistory = hist;
    gameReviewPly = -1;
    gameReviewData = data;

    el.gameProgress.hidden = true;
    renderGameSummary(data, hist);
    el.evalGraphContainer.hidden = false;
    drawEvalGraph(data.plies);
    renderGameMoveList(data);
    setEngineStatus('Game review complete', 'idle');
  } catch (error) {
    if (requestId !== gameReviewRequestId || error.name === 'AbortError') return;
    el.gameProgress.hidden = true;
    el.gameMoveList.hidden = false;
    el.gameMoveList.replaceChildren(errorBox(error.message));
    setEngineStatus('Game review failed', 'error');
  }
}

function renderGameMoveList(data) {
  const rows = [];
  let row = null;
  data.plies.forEach((p, i) => {
    const before = gameReviewPreFens.at(i).split(' ');
    const blackMove = before[1] === 'b';
    if (!blackMove || i === 0) {
      row = h('div', { class: 'game-move-row' },
        h('span', { class: 'game-move-number' }, `${before[5]}${blackMove ? '...' : '.'}`));
      if (blackMove) row.appendChild(h('span'));
      rows.push(row);
    }
    const whiteEval = toWhiteRelativeEval(p.evalCp, p.fen);
    row.appendChild(h('button', {
      type: 'button',
      class: `game-move cat-${p.category.key}`,
      dataset: { ply: String(i) },
      title: `${p.category.label} · ${formatEval(whiteEval)} · loss ${(p.deltaCp / 100).toFixed(2)}`,
      onclick: () => navigateToGamePly(i)
    }, p.san));
  });
  el.gameMoveList.replaceChildren(...rows);
  el.gameMoveList.hidden = false;
}

function navigateToGamePly(ply) {
  if (!gameReviewData || ply < 0 || ply >= gameReviewData.plies.length) return;

  gameReviewPly = ply;
  const fen = gameReviewFens.at(ply);
  const plyData = gameReviewData.plies.at(ply);

  // Load the reviewed game into the board history.
  initialFen = gameReviewPreFens[0];
  playedMoves = gameReviewHistory.map(({ from, to, promotion, san }) => ({ from, to, promotion, san }));
  currentMoveIndex = ply;
  game = new Chess(initialFen);
  playedMoves.slice(0, ply + 1).forEach((move) => game.move(move));
  board.position(fen);
  renderMoves();
  clearExplorerUI();
  clearPositionAnalysis();
  updateEvalBar(toWhiteRelativeEval(plyData.evalCp, fen));
  const lastMove = playedMoves.at(ply);
  highlightLastMove(lastMove.from, lastMove.to, plyData.category.key);

  el.gameMoveList.querySelectorAll('.game-move').forEach((m) => {
    const active = Number(m.dataset.ply) === ply;
    m.classList.toggle('active', active);
    if (active) m.scrollIntoView({ block: 'nearest' });
  });

  drawEvalGraph(gameReviewData.plies, ply);
  updateCoachHint();
}

function renderGameSummary(data, hist) {
  const keys = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];
  const blank = () => ({ counts: new Map(keys.map((key) => [key, 0])), totalDelta: 0, count: 0 });
  const sides = { w: blank(), b: blank() };

  data.plies.forEach((p, i) => {
    const side = hist.at(i).color === 'b' ? sides.b : sides.w;
    const key = p.category.key;
    if (side.counts.has(key)) side.counts.set(key, side.counts.get(key) + 1);
    side.totalDelta += p.deltaCp;
    side.count += 1;
  });

  const acpl = (side) => (side.count > 0 ? (side.totalDelta / side.count).toFixed(1) : '0');
  const range = data.opening.bookPlyRange;
  const card = (label, value, cls) => h('div', { class: 'summary-card' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${cls || ''}`.trim() }, String(value)));

  el.gameSummaryContent.replaceChildren(
    h('div', { class: 'summary-heading' },
      data.opening.eco ? h('span', { class: 'opening-eco' }, data.opening.eco) : null,
      h('strong', {}, data.opening.name),
      h('span', { class: 'summary-meta' }, `· ${data.plyCount} plies`)),
    h('div', { class: 'summary-grid' },
      card('White ACPL', acpl(sides.w)),
      card('Black ACPL', acpl(sides.b)),
      card('Turning points', data.turningPoints.length, data.turningPoints.length ? 'danger' : ''),
      card('Book moves', range ? `${range[0]}–${range[1]}` : '–')),
    h('table', { class: 'quality-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Move quality'), h('th', {}, 'White'), h('th', {}, 'Black'))),
      h('tbody', {}, keys.map((key) => h('tr', {},
        h('td', {}, h('span', { class: `eval-badge ${key}` }, classifyLabel(key))),
        h('td', {}, String(sides.w.counts.get(key))),
        h('td', {}, String(sides.b.counts.get(key))))))));
  el.gameSummary.hidden = false;
}

function classifyLabel(key) {
  return key[0].toUpperCase() + key.slice(1);
}

// ── Opening detection ──
async function detectOpening() {
  const fen = game.fen();
  try {
    setEngineStatus('Detecting opening…', 'active');
    const params = new URLSearchParams({ moves: game.history().join(' ') });
    if (initialFen !== START_FEN) params.set('fen', initialFen);
    const res = await fetch(`/api/opening?${params}`);
    if (!res.ok) throw new Error(`Opening lookup failed (HTTP ${res.status})`);
    const data = await res.json();
    if (game.fen() !== fen) return;

    const plies = game.history().length;
    const range = data.bookPlyRange;
    const plyLabel = plies === 1 ? 'ply' : 'plies';
    let meta = 'Make a move to identify the opening.';
    if (range) meta = `Book line covers plies ${range[0]}–${range[1]} · ${plies} ${plyLabel} played`;
    else if (plies) meta = 'No book line matches this move order.';
    el.openingResult.replaceChildren(h('div', { class: 'opening-card' },
      h('div', { class: 'opening-name' },
        data.eco ? h('span', { class: 'opening-eco' }, data.eco) : null,
        h('span', {}, data.name)),
      h('div', { class: 'opening-meta' }, data.name === 'Custom starting position'
        ? 'Opening detection needs a game from the standard starting position.'
        : meta)));

    el.openingContinuations.replaceChildren();
    if (data.continuations?.length) {
      el.openingContinuations.append(
        h('h3', {}, 'Book continuations'),
        h('div', { class: 'continuation-list' }, data.continuations.map((c) => h('button', {
          type: 'button',
          class: 'continuation-row',
          title: `Play ${c.move}`,
          onclick: () => {
            if (game.fen() !== fen) return;
            if (sparringActive && (isEngineThinking || game.turn() !== sparringPlayerColor)) return;
            let move = null;
            try { move = game.move(c.move); } catch (_e) {}
            if (!move) return;
            commitMove(move);
            detectOpening();
          }
        },
        h('span', { class: 'continuation-move' }, c.move),
        h('span', { class: 'continuation-name' }, c.name),
        h('span', { class: 'continuation-freq' }, c.eco)))));
    }
    setEngineStatus('Opening detected', 'idle');
  } catch (error) {
    el.openingResult.replaceChildren(errorBox(error.message));
    setEngineStatus('Opening detection failed', 'error');
  }
}

// ── Filter/sort for explorer ──
function applyExplorerFilters() {
  if (!allMovesResult || allMovesResult.length === 0) return;

  const fen = allMovesResultFen;
  let filtered = [...allMovesResult];
  if (explorerPieceFilter) filtered = filtered.filter((m) => m.pieceKey === explorerPieceFilter);

  const filterVal = el.filterPiece.value;
  if (filterVal === 'captures') {
    filtered = filtered.filter((m) => m.flags.includes('c') || m.flags.includes('e'));
  } else if (filterVal === 'checks') {
    filtered = filtered.filter((m) => /[+#]/.test(m.san));
  }

  const sortVal = el.sortMoves.value;
  if (sortVal === 'delta') {
    filtered.sort((a, b) => (a.deltaCp || 0) - (b.deltaCp || 0));
  } else if (sortVal === 'piece') {
    const order = { k: 0, q: 1, r: 2, b: 3, n: 4, p: 5 };
    filtered.sort((a, b) => (order[a.pieceKey[1]] - order[b.pieceKey[1]]) || (b.evalCp - a.evalCp));
  }
  // 'eval' keeps the server's order (best first).

  renderMovesTable(filtered, fen);
}

// ── Keyboard ──
function navigateWithKeyboard(event) {
  const review = gameReviewData && $('tab-game-review').classList.contains('active');
  const current = review ? gameReviewPly : currentMoveIndex;
  const first = review ? 0 : -1;
  const last = review ? gameReviewData.plies.length - 1 : playedMoves.length - 1;
  const targets = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: first, End: last };
  if (!(event.key in targets)) return;
  event.preventDefault();
  const target = Math.max(first, Math.min(last, targets[event.key]));
  if (review) navigateToGamePly(target);
  else jumpToHistoryPly(target);
}

function handleKeyboardShortcut(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (['TEXTAREA', 'INPUT', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable) return;
  const key = event.key.toLowerCase();
  if (key === 'h') {
    event.preventDefault();
    el.coachToggle.checked = !el.coachToggle.checked;
    el.coachToggle.dispatchEvent(new Event('change'));
  } else if (key === 'f') {
    event.preventDefault();
    $('flipBtn').click();
  } else if (key === 'z' && !event.shiftKey) {
    event.preventDefault();
    $('undoBtn').click();
  } else if (event.code === 'Space' && event.target.tagName !== 'BUTTON') {
    if (!currentCoachMove) return;
    event.preventDefault();
    applyCoachMove();
  } else {
    navigateWithKeyboard(event);
  }
}

// ── Position loading & history controls ──
function loadPosition(fen) {
  initialFen = fen;
  playedMoves = [];
  currentMoveIndex = -1;
  gameReviewRequestId += 1;
  gameReviewController?.abort();
  gameReviewController = null;
  el.gameProgress.hidden = true;
  board.position(game.fen());
  renderMoves();
  clearPositionAnalysis();
  clearSquareHighlights();
  clearExplorerUI();
  updateCoachHint();
  checkSparringTurn();
}

function loadFenFromInput() {
  const fen = el.fenInput.value.trim();
  if (!fen) return;
  try {
    game.load(fen);
  } catch (error) {
    el.fenInput.setAttribute('aria-invalid', 'true');
    el.fenError.textContent = error.message.replace(/^Invalid FEN: /, 'Invalid FEN — ');
    el.fenError.hidden = false;
    return;
  }
  // chess.js fills in omitted FEN fields, so keep its normalised form.
  loadPosition(game.fen());
}

function undoMove() {
  if (currentMoveIndex < 0) return;
  let target = currentMoveIndex - 1;
  // Against the engine, take back its reply too so it is the player's turn.
  if (sparringActive && target >= 0 && turnAfterPly(target) !== sparringPlayerColor) target -= 1;
  playedMoves = playedMoves.slice(0, target + 1);
  jumpToHistoryPly(target);
  renderMoves();
  checkSparringTurn();
}

function setSoundEnabled(enabled) {
  soundEnabled = enabled;
  el.soundToggleBtn.querySelector('use').setAttribute('href', enabled ? '#i-sound' : '#i-mute');
  el.soundToggleBtn.classList.toggle('muted', !enabled);
  el.soundToggleBtn.setAttribute('aria-pressed', String(!enabled));
  const label = enabled ? 'Mute sounds' : 'Unmute sounds';
  el.soundToggleBtn.title = label;
  el.soundToggleBtn.setAttribute('aria-label', label);
}

// ── Bind all UI events ──
function bindUI() {
  $('flipBtn').addEventListener('click', () => setBoardFlipped(!boardFlipped));

  $('resetBtn').addEventListener('click', () => {
    game.reset();
    loadPosition(START_FEN);
  });

  $('undoBtn').addEventListener('click', undoMove);
  $('loadFenBtn').addEventListener('click', loadFenFromInput);
  el.fenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadFenFromInput();
  });
  el.fenInput.addEventListener('input', () => {
    el.fenInput.removeAttribute('aria-invalid');
    el.fenError.hidden = true;
  });

  el.copyFenBtn.addEventListener('click', () => {
    navigator.clipboard?.writeText(game.fen()).catch(() => {});
    const use = el.copyFenBtn.querySelector('use');
    use.setAttribute('href', '#i-check');
    el.copyFenBtn.title = 'Copied';
    setTimeout(() => {
      use.setAttribute('href', '#i-copy');
      el.copyFenBtn.title = 'Copy FEN';
    }, 1200);
  });

  $('analyzePositionBtn').addEventListener('click', analyzePosition);
  $('analyzeAllMovesBtn').addEventListener('click', runAllMoves);
  $('analyzeGameBtn').addEventListener('click', analyzeGame);
  $('openingBtn').addEventListener('click', detectOpening);

  el.moveNavStart.addEventListener('click', () => jumpToHistoryPly(-1));
  el.moveNavPrev.addEventListener('click', () => jumpToHistoryPly(currentMoveIndex - 1));
  el.moveNavNext.addEventListener('click', () => jumpToHistoryPly(currentMoveIndex + 1));
  el.moveNavEnd.addEventListener('click', () => jumpToHistoryPly(playedMoves.length - 1));

  $('navFirst').addEventListener('click', () => navigateToGamePly(0));
  $('navPrev').addEventListener('click', () => navigateToGamePly(Math.max(0, gameReviewPly - 1)));
  $('navNext').addEventListener('click', () => {
    if (gameReviewData) navigateToGamePly(Math.min(gameReviewData.plies.length - 1, gameReviewPly + 1));
  });
  $('navLast').addEventListener('click', () => {
    if (gameReviewData) navigateToGamePly(gameReviewData.plies.length - 1);
  });

  el.filterPiece.addEventListener('change', applyExplorerFilters);
  el.sortMoves.addEventListener('change', applyExplorerFilters);

  document.addEventListener('keydown', handleKeyboardShortcut);

  el.evalGraph.addEventListener('click', (e) => {
    if (!gameReviewData) return;
    const rect = el.evalGraph.getBoundingClientRect();
    const left = 30;
    const width = rect.width - left - 8;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - left) / width));
    navigateToGamePly(Math.round(ratio * (gameReviewData.plies.length - 1)));
  });

  // Keep the board, its overlays, and the graph sized to their containers.
  let lastWidth = 0;
  let resizeFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const width = el.boardContainer.clientWidth;
      if (width !== lastWidth) {
        lastWidth = width;
        board.resize();
      }
      syncOverlaySize();
      if (gameReviewData) drawEvalGraph(gameReviewData.plies, gameReviewPly);
    });
  }).observe(document.body);

  el.coachToggle.checked = coachEnabled;
  el.coachToggle.addEventListener('change', (e) => {
    coachEnabled = e.target.checked;
    currentCoachMove = null;
    try { localStorage.setItem('pawnforge_coach', coachEnabled ? 'true' : 'false'); } catch (_e) {}
    updateCoachHint();
  });
  el.applyCoachMoveBtn.addEventListener('click', applyCoachMove);

  el.soundToggleBtn.addEventListener('click', () => {
    setSoundEnabled(!soundEnabled);
    try { localStorage.setItem('pawnforge_sound', soundEnabled ? 'true' : 'false'); } catch (_e) {}
  });

  el.sparringToggle.addEventListener('change', (e) => {
    invalidateSparring();
    sparringActive = e.target.checked;
    if (sparringActive) {
      sparringPlayerColor = el.sparringColor.value;
      orientForSparring();
      checkSparringTurn();
    } else {
      setEngineStatus('Ready', 'idle');
    }
    updateCoachHint();
  });
  el.sparringColor.addEventListener('change', (e) => {
    invalidateSparring();
    sparringPlayerColor = e.target.value;
    orientForSparring();
    if (sparringActive) checkSparringTurn();
    updateCoachHint();
  });
}

// ── Embed Mode & Query Param Configuration ──
const urlParams = new URLSearchParams(window.location.search);
if (['true', '1'].includes(urlParams.get('embed'))) document.body.classList.add('embed-mode');
if (['true', '1'].includes(urlParams.get('coach'))) {
  coachEnabled = true;
} else {
  try { coachEnabled = localStorage.getItem('pawnforge_coach') === 'true'; } catch (_e) {}
}

// ── Initialize ──
try {
  const savedSound = localStorage.getItem('pawnforge_sound');
  if (savedSound !== null) soundEnabled = savedSound === 'true';
} catch (_e) {}
setSoundEnabled(soundEnabled);

board = window.Chessboard('board', {
  draggable: true,
  position: 'start',
  pieceTheme: (piece) => PIECE_THEME.get(piece),
  onDragStart,
  onDrop,
  onSnapEnd
});

initTabs();
bindUI();
syncOverlaySize();
renderMoves();
updateEvalBar(0);
updateCoachHint();
