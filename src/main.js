import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.1.0/+esm';

const game = new Chess();
let board = null;
let puzzle = null;
let puzzleStep = 0;

const engineStatus = document.getElementById('engineStatus');
const engineOutput = document.getElementById('engineOutput');
const moveListEl = document.getElementById('moveList');
const puzzleInfo = document.getElementById('puzzleInfo');

const puzzles = [
  {
    title: 'Mate in 1',
    fen: '6k1/5ppp/8/8/8/8/6PP/6KQ w - - 0 1',
    solution: ['Qh8#'],
    hint: 'Look for a forcing queen move on the back rank.'
  },
  {
    title: 'Win the queen',
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 0 3',
    solution: ['Nxd4'],
    hint: 'A central capture wins material by tactic.'
  }
];

function renderMoves() {
  const history = game.history({ verbose: true });
  moveListEl.innerHTML = '';
  history.forEach((m, i) => {
    const li = document.createElement('li');
    li.textContent = `${Math.floor(i / 2) + 1}${i % 2 === 0 ? '. ' : '... '}${m.san}`;
    moveListEl.appendChild(li);
  });
}

function onDrop(source, target) {
  const move = game.move({ from: source, to: target, promotion: 'q' });
  if (!move) return 'snapback';

  renderMoves();
  validatePuzzleMove(move.san);
  return undefined;
}

function onSnapEnd() {
  board.position(game.fen());
}

function setupBoard() {
  board = window.Chessboard('board', {
    draggable: true,
    position: 'start',
    onDrop,
    onSnapEnd
  });
}

function analyzePosition() {
  const depth = Number(document.getElementById('depthSelect').value);
  const legal = game.moves({ verbose: true });

  if (legal.length === 0) {
    engineStatus.textContent = 'No legal moves in this position.';
    engineOutput.textContent = game.isCheckmate()
      ? 'Checkmate on board.'
      : 'Stalemate or draw state.';
    return;
  }

  const scoring = legal
    .map((m) => {
      game.move(m);
      const score = staticEval(game);
      game.undo();
      return { san: m.san, from: m.from, to: m.to, score };
    })
    .sort((a, b) => (game.turn() === 'w' ? b.score - a.score : a.score - b.score));

  const top = scoring.slice(0, 3);
  const lines = top.map((m, i) => `${i + 1}. ${m.san} (${m.from}-${m.to}) eval ${m.score > 0 ? '+' : ''}${m.score.toFixed(2)}`);

  engineStatus.textContent = `Analyzed ${legal.length} legal moves at depth ${depth} (fast static evaluator).`;
  engineOutput.textContent = lines.join('\n');
}

function staticEval(chess) {
  const values = { p: 1, n: 3.1, b: 3.3, r: 5, q: 9, k: 0 };
  let score = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const value = values[piece.type] ?? 0;
      score += piece.color === 'w' ? value : -value;
    }
  }

  const mobility = chess.moves().length * 0.02;
  score += chess.turn() === 'w' ? mobility : -mobility;

  if (chess.isCheckmate()) {
    score += chess.turn() === 'w' ? -999 : 999;
  }
  return score;
}

function loadPuzzle() {
  puzzle = puzzles[Math.floor(Math.random() * puzzles.length)];
  puzzleStep = 0;
  game.load(puzzle.fen);
  board.position(game.fen());
  renderMoves();
  puzzleInfo.textContent = `Puzzle: ${puzzle.title}. Find the best move.`;
  puzzleInfo.classList.remove('good');
}

function validatePuzzleMove(san) {
  if (!puzzle) return;

  const expected = puzzle.solution[puzzleStep];
  if (san === expected) {
    puzzleStep += 1;
    if (puzzleStep === puzzle.solution.length) {
      puzzleInfo.textContent = `✅ Correct! Solved: ${puzzle.title}`;
      puzzleInfo.classList.add('good');
      puzzle = null;
    } else {
      puzzleInfo.textContent = 'Good move. Continue the sequence.';
      puzzleInfo.classList.add('good');
    }
  } else {
    puzzleInfo.textContent = `Not the puzzle move. Try again.`;
    puzzleInfo.classList.remove('good');
  }
}

function bindUI() {
  document.getElementById('flipBtn').addEventListener('click', () => board.flip());

  document.getElementById('resetBtn').addEventListener('click', () => {
    game.reset();
    board.start();
    renderMoves();
    puzzle = null;
    puzzleInfo.textContent = 'Board reset. Click “New Puzzle” to train.';
    puzzleInfo.classList.remove('good');
  });

  document.getElementById('copyFenBtn').addEventListener('click', async () => {
    const fen = game.fen();
    try {
      await navigator.clipboard.writeText(fen);
      engineStatus.textContent = 'FEN copied to clipboard.';
    } catch {
      engineStatus.textContent = `FEN: ${fen}`;
    }
  });

  document.getElementById('analyzeBtn').addEventListener('click', analyzePosition);

  document.getElementById('newPuzzleBtn').addEventListener('click', loadPuzzle);

  document.getElementById('showHintBtn').addEventListener('click', () => {
    if (!puzzle) {
      puzzleInfo.textContent = 'No active puzzle. Click “New Puzzle”.';
      return;
    }
    puzzleInfo.textContent = `Hint: ${puzzle.hint}`;
  });
}

setupBoard();
bindUI();
renderMoves();
