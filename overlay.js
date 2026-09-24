/**
 * PawnForge Coach Overlay.
 *
 * This file works as a Chrome content script and as a bookmarklet-style
 * script. It prefers a full FEN exposed by the page, then falls back to
 * reading visible chess pieces from a standard DOM board.
 */
(() => {
  const root = globalThis;
  const existingHud = document.getElementById('pawnforge-hud');

  if (root.__pawnforge_overlay_loaded) {
    if (existingHud) {
      existingHud.hidden = !existingHud.hidden;
      existingHud.setAttribute('aria-hidden', String(existingHud.hidden));
    }
    return;
  }

  root.__pawnforge_overlay_loaded = true;

  const DEFAULT_ENDPOINT = 'http://127.0.0.1:4173/api/analyze/position';
  const isExtension = Boolean(root.chrome?.runtime?.id);
  const extensionRuntime = isExtension ? root.chrome.runtime : null;
  const extensionStorage = isExtension ? root.chrome.storage?.local : null;

  let active = true;
  let endpoint = DEFAULT_ENDPOINT;
  let sideMode = 'auto';
  let lastPositionKey = '';
  let activeCandidates = [];
  let currentSnapshot = null;
  let pointerMove = null;
  let analysisRequest = 0;
  let analysisController = null;
  let analysisInFlight = false;
  let observedPositionKey = '';
  let observedPositionAt = 0;
  let pageFenPromise = null;
  let pageFenRequestedAt = 0;

  const POSITION_STABILITY_MS = 600;

  const style = document.createElement('style');
  style.textContent = `
    #pawnforge-hud {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 2147483646;
      width: min(360px, calc(100vw - 32px));
      box-sizing: border-box;
      padding: 14px;
      border: 1px solid rgba(34, 197, 94, 0.45);
      border-radius: 14px;
      background: rgba(15, 23, 42, 0.97);
      box-shadow: 0 16px 42px rgba(0, 0, 0, 0.48);
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.4;
      user-select: none;
    }
    #pawnforge-hud[hidden] { display: none; }
    #pawnforge-hud, #pawnforge-hud * { box-sizing: border-box; }
    #pawnforge-hud-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
      cursor: move;
    }
    #pawnforge-hud-title {
      display: flex;
      align-items: center;
      gap: 7px;
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    #pawnforge-hud-title-mark { color: #4ade80; font-size: 18px; }
    .pawnforge-toggle {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: #cbd5e1;
      cursor: pointer;
      font-size: 11px;
      white-space: nowrap;
    }
    .pawnforge-toggle input { position: absolute; opacity: 0; pointer-events: none; }
    .pawnforge-slider {
      position: relative;
      display: inline-block;
      width: 30px;
      height: 17px;
      border-radius: 17px;
      background: #475569;
      transition: background 160ms ease;
    }
    .pawnforge-slider::before {
      content: "";
      position: absolute;
      left: 2px;
      top: 2px;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #fff;
      transition: transform 160ms ease;
    }
    .pawnforge-toggle input:checked + .pawnforge-slider { background: #16a34a; }
    .pawnforge-toggle input:checked + .pawnforge-slider::before { transform: translateX(13px); }
    #pawnforge-hud-body { color: #94a3b8; }
    #pawnforge-hud-msg { min-height: 34px; }
    .pawnforge-control-row {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-top: 8px;
    }
    .pawnforge-control-row label { flex: 0 0 auto; color: #cbd5e1; font-size: 11px; }
    .pawnforge-control-row input,
    .pawnforge-control-row select {
      min-width: 0;
      flex: 1 1 auto;
      height: 28px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 6px;
      padding: 0 7px;
      background: rgba(30, 41, 59, 0.95);
      color: #f8fafc;
      font: inherit;
    }
    .pawnforge-control-row button,
    .pawnforge-candidate-pill {
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 6px;
      background: rgba(51, 65, 85, 0.8);
      color: #e2e8f0;
      cursor: pointer;
      font: inherit;
    }
    .pawnforge-control-row button { height: 28px; padding: 0 9px; white-space: nowrap; }
    .pawnforge-control-row button:hover,
    .pawnforge-control-row button:focus-visible,
    .pawnforge-candidate-pill:hover,
    .pawnforge-candidate-pill:focus-visible,
    .pawnforge-candidate-pill.active {
      border-color: #22c55e;
      background: rgba(34, 197, 94, 0.2);
      color: #fff;
      outline: none;
    }
    .pawnforge-hint { margin-top: 8px; color: #94a3b8; font-size: 11px; }
    .pawnforge-move-tag {
      display: inline-block;
      margin-right: 6px;
      border-radius: 6px;
      padding: 3px 8px;
      background: rgba(34, 197, 94, 0.18);
      color: #4ade80;
      font-size: 15px;
      font-weight: 700;
    }
    .pawnforge-eval-tag {
      display: inline-block;
      border-radius: 5px;
      padding: 2px 6px;
      background: rgba(255, 255, 255, 0.1);
      color: #f1f5f9;
      font-weight: 600;
    }
    .pawnforge-candidate-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
    .pawnforge-candidate-pill { padding: 3px 7px; font-size: 11px; }
    .pawnforge-pointer {
      position: fixed;
      z-index: 2147483645;
      pointer-events: none;
      box-sizing: border-box;
    }
    .pawnforge-pointer-origin {
      border: 3px solid #ef4444;
      border-radius: 8px;
      background: rgba(239, 68, 68, 0.2);
      box-shadow: 0 0 18px rgba(239, 68, 68, 0.95), inset 0 0 10px rgba(239, 68, 68, 0.38);
      animation: pawnforge-pulse 1.35s infinite alternate ease-in-out;
    }
    .pawnforge-pointer-target {
      border: 3px solid #ef4444;
      border-radius: 8px;
      background: rgba(239, 68, 68, 0.38);
      box-shadow: 0 0 18px rgba(239, 68, 68, 0.9), inset 0 0 12px rgba(239, 68, 68, 0.34);
    }
    @keyframes pawnforge-pulse {
      from { transform: scale(0.96); opacity: 0.78; }
      to { transform: scale(1.04); opacity: 1; }
    }
    @media (max-width: 540px) {
      #pawnforge-hud { right: 12px; bottom: 12px; }
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  const hud = document.createElement('aside');
  hud.id = 'pawnforge-hud';
  hud.setAttribute('role', 'region');
  hud.setAttribute('aria-label', 'PawnForge Coach overlay');
  hud.innerHTML = `
    <div id="pawnforge-hud-header">
      <div id="pawnforge-hud-title"><span id="pawnforge-hud-title-mark" aria-hidden="true">♟</span> PawnForge Coach</div>
      <label class="pawnforge-toggle" title="Toggle coach assistance">
        <input type="checkbox" id="pawnforge-coach-switch" checked />
        <span class="pawnforge-slider" aria-hidden="true"></span>
        <span>Coach</span>
      </label>
    </div>
    <div id="pawnforge-hud-body">
      <div id="pawnforge-hud-msg" role="status" aria-live="polite">Looking for a chess position...</div>
      <label><input id="pawnforge-approximate" type="checkbox" /> Analyze approximate DOM position (special move rights unknown)</label>
      <div id="pawnforge-hud-candidates" class="pawnforge-candidate-list"></div>
      <div class="pawnforge-control-row">
        <label for="pawnforge-side">Side</label>
        <select id="pawnforge-side" aria-label="Side to move">
          <option value="auto">Auto detect</option>
          <option value="w">White to move</option>
          <option value="b">Black to move</option>
        </select>
        <button id="pawnforge-analyze" type="button">Analyze</button>
      </div>
      <div class="pawnforge-control-row">
        <label for="pawnforge-fen">FEN</label>
        <input id="pawnforge-fen" type="text" autocomplete="off" spellcheck="false" placeholder="Optional position FEN" aria-label="Optional position FEN" />
        <button id="pawnforge-use-fen" type="button">Use</button>
      </div>
      <div class="pawnforge-control-row">
        <label for="pawnforge-endpoint">API</label>
        <input id="pawnforge-endpoint" type="url" autocomplete="off" spellcheck="false" aria-label="PawnForge API endpoint" />
        <button id="pawnforge-save-endpoint" type="button">Save</button>
      </div>
      <div class="pawnforge-hint" id="pawnforge-hint">The overlay reads a page FEN when available, then visible board pieces.</div>
    </div>
  `;
  document.body.appendChild(hud);

  const switchEl = hud.querySelector('#pawnforge-coach-switch');
  const msgEl = hud.querySelector('#pawnforge-hud-msg');
  const candidateEl = hud.querySelector('#pawnforge-hud-candidates');
  const sideEl = hud.querySelector('#pawnforge-side');
  const fenEl = hud.querySelector('#pawnforge-fen');
  const analyzeEl = hud.querySelector('#pawnforge-analyze');
  const useFenEl = hud.querySelector('#pawnforge-use-fen');
  const endpointEl = hud.querySelector('#pawnforge-endpoint');
  const saveEndpointEl = hud.querySelector('#pawnforge-save-endpoint');
  const hintEl = hud.querySelector('#pawnforge-hint');
  endpointEl.value = endpoint;

  function setMessage(text) {
    msgEl.textContent = text;
  }

  function setHint(text) {
    hintEl.textContent = text;
  }

  function removePointers() {
    document.querySelectorAll('[data-pawnforge-pointer]').forEach((element) => element.remove());
    pointerMove = null;
  }

  function clearAnalysisUi() {
    activeCandidates = [];
    candidateEl.replaceChildren();
    removePointers();
  }

  function isFenLike(value) {
    if (typeof value !== 'string') return false;
    const fields = value.trim().split(/\s+/);
    if (fields.length !== 6 || !/^[wb]$/.test(fields[1])) return false;
    const rows = fields[0].split('/');
    if (rows.length !== 8) return false;
    return rows.every((row) => {
      let count = 0;
      for (const token of row) {
        if (/\d/.test(token)) count += Number(token);
        else if (/[prnbqkPRNBQK]/.test(token)) count += 1;
        else return false;
      }
      return count === 8;
    });
  }

  function normaliseFen(value) {
    if (!isFenLike(value)) return null;
    const fields = value.trim().split(/\s+/);
    return fields.join(' ');
  }

  function classText(element) {
    if (!element) return '';
    const value = element.getAttribute?.('class');
    return typeof value === 'string' ? value.toLowerCase() : '';
  }

  function boardOrientation(board) {
    const elements = [board, board?.parentElement, board?.parentElement?.parentElement];
    const attributes = elements.flatMap((element) => [
      element?.getAttribute?.('data-orientation') || '',
      element?.getAttribute?.('data-side') || '',
      element?.getAttribute?.('data-flipped') || '',
      classText(element)
    ]).join(' ');
    const explicitlyFlipped = elements.some((element) => element?.getAttribute?.('data-flipped') === 'true');
    return explicitlyFlipped || /orientation[-_ ]?black|flipped|\bblack[-_ ]?bottom\b/.test(attributes) ? 'black' : 'white';
  }

  function isSquareBoard(rect) {
    return rect && rect.width >= 160 && rect.height >= 160 && rect.width / rect.height > 0.72 && rect.width / rect.height < 1.38;
  }

  function findBoardModel() {
    const selectors = [
      'cg-board',
      '.cg-board',
      '[data-board]',
      '[role="grid"]',
      '[class*="chessboard" i]',
      '[class*="chess-board" i]',
      '[class*="board" i]'
    ];
    const candidates = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element) || element.id === 'pawnforge-hud' || element.closest?.('#pawnforge-hud')) continue;
        seen.add(element);
        const rect = element.getBoundingClientRect();
        if (isSquareBoard(rect)) candidates.push({ element, rect, area: rect.width * rect.height });
      }
    }
    const scored = candidates.map((candidate) => ({
      ...candidate,
      pieceCount: candidate.element.querySelectorAll('.piece, piece, [data-piece], [data-color][data-type]').length
    }));
    const selected = scored.sort((a, b) => b.pieceCount - a.pieceCount || a.area - b.area)[0];
    return selected ? { ...selected, orientation: boardOrientation(selected.element) } : null;
  }

  function pieceToken(element) {
    const text = [
      element.getAttribute?.('data-piece'),
      element.getAttribute?.('data-color'),
      element.getAttribute?.('data-type'),
      classText(element)
    ].filter(Boolean).join(' ').toLowerCase();
    const compact = text.match(/(?:^|\s)([wb])([pnbrqk])(?:\s|$)/);
    if (compact) return compact[1] === 'w' ? compact[2].toUpperCase() : compact[2];
    const type = text.match(/\b(pawn|knight|bishop|rook|queen|king)\b/);
    if (!type) return null;
    const pieceByName = { pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' };
    const symbol = pieceByName[type[1]];
    const isBlack = /\bblack\b|\bdark\b/.test(text);
    const isWhite = /\bwhite\b|\blight\b/.test(text);
    return isBlack ? symbol.toLowerCase() : isWhite ? symbol : null;
  }

  function squareFromPoint(rect, x, y, orientation) {
    const xIndex = Math.max(0, Math.min(7, Math.floor(((x - rect.left) / rect.width) * 8)));
    const yIndex = Math.max(0, Math.min(7, Math.floor(((y - rect.top) / rect.height) * 8)));
    const fileIndex = orientation === 'black' ? 7 - xIndex : xIndex;
    const rank = orientation === 'black' ? yIndex + 1 : 8 - yIndex;
    return `${String.fromCharCode(97 + fileIndex)}${rank}`;
  }

  function explicitSquare(element) {
    const dataSquare = element.getAttribute?.('data-square') || element.getAttribute?.('data-position');
    if (/^[a-h][1-8]$/.test(dataSquare || '')) return dataSquare.toLowerCase();
    const match = classText(element).match(/(?:^|\s)square-([1-8])([1-8])(?:\s|$)/);
    if (!match) return null;
    return `${String.fromCharCode(96 + Number(match[1]))}${match[2]}`;
  }

  function sideFromDom(board) {
    if (sideMode === 'w' || sideMode === 'b') return sideMode;
    const elements = [board?.element, board?.element?.parentElement, board?.element?.parentElement?.parentElement];
    for (const element of elements) {
      if (!element) continue;
      for (const attribute of ['data-turn', 'data-side-to-move', 'aria-label']) {
        const value = (element.getAttribute(attribute) || '').toLowerCase();
        if (attribute !== 'aria-label' && /^(white|w)$/.test(value)) return 'w';
        if (attribute !== 'aria-label' && /^(black|b)$/.test(value)) return 'b';
        if (/\bwhite\b|^w$/.test(value) && /turn|move|side|^w$/.test(value)) return 'w';
        if (/\bblack\b|^b$/.test(value) && /turn|move|side|^b$/.test(value)) return 'b';
      }
      const classes = classText(element);
      if (/turn[-_ ]?white|white[-_ ]?to[-_ ]?move|white[-_ ]?turn/.test(classes)) return 'w';
      if (/turn[-_ ]?black|black[-_ ]?to[-_ ]?move|black[-_ ]?turn/.test(classes)) return 'b';
    }
    return null;
  }

  function moveRowText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function sideFromMoveList() {
    const rows = [];
    for (const element of document.querySelectorAll('body *')) {
      const text = moveRowText(element.textContent);
      if (!/^\d+\.\s*\S+(?:\s+\S+)?$/.test(text)) continue;
      rows.push(text);
    }
    const lastRow = rows.at(-1);
    if (!lastRow) return null;
    const match = lastRow.match(/^\d+\.\s*\S+(?:\s+(\S+))?$/);
    if (!match) return null;
    return match[1] ? 'w' : 'b';
  }

  function readDomPosition() {
    const board = findBoardModel();
    if (!board) return null;
    const pieceSelectors = ['.piece', 'piece', '[data-piece]', '[data-color][data-type]'];
    const pieces = [];
    const seen = new Set();
    for (const selector of pieceSelectors) {
      for (const element of board.element.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        const piece = pieceToken(element);
        const rect = element.getBoundingClientRect();
        const computed = window.getComputedStyle(element);
        const isVisible = computed.display !== 'none' && computed.visibility !== 'hidden' && Number(computed.opacity || 1) > 0.05;
        if (piece && isVisible && rect.width > 2 && rect.height > 2 && rect.right > board.rect.left && rect.left < board.rect.right && rect.bottom > board.rect.top && rect.top < board.rect.bottom) {
          pieces.push({ piece, rect, square: explicitSquare(element) });
        }
      }
    }
    if (pieces.length < 2) return null;
    const explicitPieces = pieces.filter((item) => item.square);
    const sourcePieces = explicitPieces.length >= 2 ? explicitPieces : pieces;
    const squares = new Map();
    for (const item of sourcePieces) {
      const square = item.square || squareFromPoint(board.rect, item.rect.left + item.rect.width / 2, item.rect.top + item.rect.height / 2, board.orientation);
      squares.set(square, item.piece);
    }
    const rows = [];
    for (let rank = 8; rank >= 1; rank -= 1) {
      let empty = 0;
      let row = '';
      for (let file = 0; file < 8; file += 1) {
        const piece = squares.get(`${String.fromCharCode(97 + file)}${rank}`);
        if (!piece) empty += 1;
        else {
          if (empty) row += empty;
          empty = 0;
          row += piece;
        }
      }
      if (empty) row += empty;
      rows.push(row);
    }
    const pieceValues = [...squares.values()];
    const whiteKingCount = pieceValues.filter((piece) => piece === 'K').length;
    const blackKingCount = pieceValues.filter((piece) => piece === 'k').length;
    const whitePawnCount = pieceValues.filter((piece) => piece === 'P').length;
    const blackPawnCount = pieceValues.filter((piece) => piece === 'p').length;
    if (pieceValues.length > 32 || whiteKingCount !== 1 || blackKingCount !== 1 || whitePawnCount > 8 || blackPawnCount > 8) {
      return { board, unstable: true };
    }
    const side = sideFromDom(board) || sideFromMoveList();
    if (!side) return { board, sideUnknown: true };
    return { fen: `${rows.join('/')} ${side} - - 0 1`, board, source: 'approximate visible board', approximate: true };
  }

  function readSameWorldFen() {
    const candidates = [
      typeof root.game?.fen === 'function' ? root.game.fen() : null,
      typeof root.chess?.fen === 'function' ? root.chess.fen() : null,
      root.__PAWNFORGE_FEN__,
      document.querySelector('input#fenInput, input[name="fen"], input.fen')?.value
    ];
    return candidates.map(normaliseFen).find(Boolean) || null;
  }

  function readPageFen() {
    const sameWorld = readSameWorldFen();
    if (sameWorld || !isExtension || !extensionRuntime?.sendMessage) return Promise.resolve(sameWorld);
    const now = Date.now();
    if (pageFenPromise && now - pageFenRequestedAt < 900) return pageFenPromise;
    pageFenRequestedAt = now;
    pageFenPromise = new Promise((resolve) => {
      extensionRuntime.sendMessage({ type: 'read-page-fen' }, (response) => {
        if (root.chrome.runtime.lastError) resolve(null);
        else resolve(normaliseFen(response?.fen));
      });
    }).finally(() => {
      window.setTimeout(() => { pageFenPromise = null; }, 500);
    });
    return pageFenPromise;
  }

  async function detectCurrentPosition() {
    const manualFen = normaliseFen(fenEl.value);
    if (manualFen) return { fen: manualFen, source: 'manual FEN', board: findBoardModel() };
    const pageFen = await readPageFen();
    if (pageFen) return { fen: pageFen, source: 'page FEN', board: findBoardModel() };
    return readDomPosition();
  }

  function squareRect(board, square) {
    if (!board || !/^[a-h][1-8]$/.test(square)) return null;
    const fileIndex = square.charCodeAt(0) - 97;
    const rank = Number(square[1]);
    const xIndex = board.orientation === 'black' ? 7 - fileIndex : fileIndex;
    const yIndex = board.orientation === 'black' ? rank - 1 : 8 - rank;
    return {
      left: board.rect.left + (xIndex * board.rect.width) / 8,
      top: board.rect.top + (yIndex * board.rect.height) / 8,
      width: board.rect.width / 8,
      height: board.rect.height / 8
    };
  }

  function updatePointerPositions() {
    if (!pointerMove) return;
    const board = findBoardModel();
    const origin = squareRect(board, pointerMove.from);
    const target = squareRect(board, pointerMove.to);
    const originEl = document.querySelector('[data-pawnforge-pointer="origin"]');
    const targetEl = document.querySelector('[data-pawnforge-pointer="target"]');
    for (const [element, rect] of [[originEl, origin], [targetEl, target]]) {
      if (!element || !rect) continue;
      element.style.left = `${rect.left + 2}px`;
      element.style.top = `${rect.top + 2}px`;
      element.style.width = `${Math.max(0, rect.width - 4)}px`;
      element.style.height = `${Math.max(0, rect.height - 4)}px`;
    }
  }

  function renderSquarePointers(from, to) {
    removePointers();
    pointerMove = { from, to };
    const origin = document.createElement('div');
    origin.className = 'pawnforge-pointer pawnforge-pointer-origin';
    origin.dataset.pawnforgePointer = 'origin';
    const target = document.createElement('div');
    target.className = 'pawnforge-pointer pawnforge-pointer-target';
    target.dataset.pawnforgePointer = 'target';
    document.body.append(origin, target);
    updatePointerPositions();
  }

  function formatEvaluation(value) {
    const score = Number(value);
    if (!Number.isFinite(score)) return 'engine';
    // The server encodes mate in N as ±(100000 - N) from the mover's view.
    if (Math.abs(score) >= 99000) return `${score > 0 ? '' : '-'}#${100000 - Math.abs(score) || ''}`;
    const formatted = (score / 100).toFixed(2);
    return score >= 0 ? `+${formatted}` : formatted;
  }

  function pieceNameAt(fen, square) {
    const rows = String(fen || '').split(' ')[0].split('/');
    const rank = Number(square?.[1]);
    const file = square?.charCodeAt(0) - 97;
    const row = rows[8 - rank];
    if (!row || !Number.isInteger(file) || file < 0 || file > 7) return 'piece';
    let fileIndex = 0;
    for (const token of row) {
      if (/\d/.test(token)) {
        fileIndex += Number(token);
      } else {
        if (fileIndex === file) {
          const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
          return names[token.toLowerCase()] || 'piece';
        }
        fileIndex += 1;
      }
    }
    return 'piece';
  }

  function selectCandidate(index) {
    const candidate = activeCandidates[index];
    if (!candidate || typeof candidate.uci !== 'string' || candidate.uci.length < 4) return;
    const from = candidate.uci.slice(0, 2).toUpperCase();
    const to = candidate.uci.slice(2, 4).toUpperCase();
    const turn = (currentSnapshot?.fen || '').split(' ')[1] === 'b' ? 'Black' : 'White';
    const pieceName = pieceNameAt(currentSnapshot?.fen, candidate.uci.slice(0, 2));
    const moveLine = typeof candidate.pv === 'string' ? candidate.pv.split(/\s+/).slice(0, 5).join(' ') : '';
    msgEl.replaceChildren();
    const summary = document.createElement('div');
    const move = document.createElement('span');
    move.className = 'pawnforge-move-tag';
    move.textContent = `${from} ➜ ${to}`;
    const evaluation = document.createElement('span');
    evaluation.className = 'pawnforge-eval-tag';
    evaluation.textContent = formatEvaluation(candidate.evalCp);
    summary.append(move, evaluation);
    const explanation = document.createElement('div');
    explanation.style.cssText = 'margin-top:6px;color:#cbd5e1;font-size:11px;';
    explanation.textContent = `${turn} should move the ${pieceName} on ${from} to ${to}${moveLine ? ` · ${moveLine}` : ''}`;
    msgEl.append(summary, explanation);
    candidateEl.querySelectorAll('.pawnforge-candidate-pill').forEach((element, candidateIndex) => {
      element.classList.toggle('active', candidateIndex === index);
    });
    renderSquarePointers(candidate.uci.slice(0, 2), candidate.uci.slice(2, 4));
  }

  function renderCandidates(candidates) {
    candidateEl.replaceChildren();
    activeCandidates = Array.isArray(candidates) ? candidates.slice(0, 5) : [];
    activeCandidates.forEach((candidate, index) => {
      if (!candidate || typeof candidate.uci !== 'string') return;
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `pawnforge-candidate-pill${index === 0 ? ' active' : ''}`;
      pill.textContent = `#${index + 1} ${candidate.uci.slice(0, 2).toUpperCase()}-${candidate.uci.slice(2, 4).toUpperCase()} (${formatEvaluation(candidate.evalCp)})`;
      pill.addEventListener('click', () => selectCandidate(index));
      candidateEl.appendChild(pill);
    });
    if (activeCandidates.length) selectCandidate(0);
  }

  async function analyzePosition(force = false) {
    if (!active) return;
    if (analysisInFlight) {
      if (force) { analysisRequest += 1; analysisController?.abort(); lastPositionKey = ''; }
      return;
    }
    const requestId = ++analysisRequest;
    const snapshot = await detectCurrentPosition();
    if (!active || requestId !== analysisRequest) return;

    if (!snapshot?.fen) {
      if (snapshot?.unstable) {
        lastPositionKey = '';
        currentSnapshot = snapshot;
        clearAnalysisUi();
        setMessage('Waiting for the board to settle...');
        setHint('The site is animating or exposing duplicate pieces.');
      } else if (snapshot?.sideUnknown) {
        lastPositionKey = '';
        currentSnapshot = snapshot;
        clearAnalysisUi();
        setMessage('Board found. Choose White or Black, then Analyze.');
        setHint('The site exposes pieces but not the side to move.');
      } else {
        lastPositionKey = '';
        currentSnapshot = null;
        clearAnalysisUi();
        setMessage('No chess position found on this page.');
        setHint('Open a chessboard or paste a full FEN above.');
      }
      return;
    }

    if (snapshot.approximate && !hud.querySelector('#pawnforge-approximate').checked) {
      lastPositionKey = '';
      clearAnalysisUi();
      setMessage('Board found. Paste a full FEN for accurate analysis.');
      setHint('DOM pieces do not reveal castling, en passant, or draw counters. Approximate analysis requires opting in.');
      return;
    }
    const now = Date.now();
    if (!force) {
      if (snapshot.fen !== observedPositionKey) {
        observedPositionKey = snapshot.fen;
        observedPositionAt = now;
        return;
      }
      if (now - observedPositionAt < POSITION_STABILITY_MS) return;
    } else {
      observedPositionKey = snapshot.fen;
      observedPositionAt = now;
    }

    if (!force && snapshot.fen === lastPositionKey) {
      currentSnapshot = snapshot;
      updatePointerPositions();
      return;
    }

    if (analysisInFlight) return;

    lastPositionKey = snapshot.fen;
    currentSnapshot = snapshot;
    clearAnalysisUi();
    setMessage(`Analyzing ${snapshot.source || 'position'}...`);
    setHint('PawnForge is checking the strongest legal continuations.');
    analysisInFlight = true;
    analysisController = new AbortController();

    try {
      const payload = { fen: snapshot.fen, settings: { depth: 8, multiPv: 3 } };
      let data;
      if (isExtension) {
        const result = await extensionRuntime.sendMessage({ type: 'analyze-position', endpoint, payload });
        if (result?.error) throw new Error(result.error);
        data = result.data;
      } else {
        const response = await fetch(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: analysisController.signal
        });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || `Engine returned HTTP ${response.status}`);
      }
      if (!active || requestId !== analysisRequest || snapshot.fen !== lastPositionKey) return;
      const latestSnapshot = await detectCurrentPosition();
      if (!active || requestId !== analysisRequest) return;
      if (!latestSnapshot?.fen || latestSnapshot.fen !== snapshot.fen) {
        lastPositionKey = '';
        currentSnapshot = latestSnapshot;
        clearAnalysisUi();
        setMessage(latestSnapshot?.unstable ? 'Waiting for the board to settle...' : 'Board changed. Re-analyzing...');
        setHint(latestSnapshot?.unstable ? 'The site is animating or exposing duplicate pieces.' : 'The position changed while the engine was thinking.');
        window.setTimeout(() => analyzePosition(false), POSITION_STABILITY_MS + 25);
        return;
      }
      if (!Array.isArray(data.topMoves) || data.topMoves.length === 0) {
        setMessage('The engine returned no legal moves for this position.');
        return;
      }
      renderCandidates(data.topMoves);
      setHint(snapshot.approximate ? 'Approximate: castling and en passant disabled; draw counters unknown. Paste a full FEN for accurate results.' : `Source: ${snapshot.source || 'position'}. Select a line to move the highlights.`);
    } catch (error) {
      if (error?.name === 'AbortError' || requestId !== analysisRequest) return;
      lastPositionKey = '';
      clearAnalysisUi();
      setMessage('Engine unavailable. Start PawnForge and check the endpoint.');
      setHint(error?.message || endpoint);
    } finally {
      analysisInFlight = false;
    }
  }

  async function loadSettings() {
    if (!extensionStorage) return;
    try {
      const stored = await extensionStorage.get(['endpoint', 'sideMode']);
      if (typeof stored.endpoint === 'string') {
        const url = new URL(stored.endpoint);
        if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/api/analyze/position') endpoint = url.toString();
      }
      if (stored.sideMode === 'w' || stored.sideMode === 'b' || stored.sideMode === 'auto') sideMode = stored.sideMode;
      sideEl.value = sideMode;
      endpointEl.value = endpoint;
    } catch (_error) {
      setHint('Using the default local PawnForge endpoint.');
    }
  }

  function persistSettings() {
    if (!extensionStorage) return;
    extensionStorage.set({ endpoint, sideMode }).catch(() => {});
  }

  function setActive(next) {
    active = next;
    switchEl.checked = active;
    if (!active) {
      analysisRequest += 1;
      if (analysisController) analysisController.abort();
      clearAnalysisUi();
      setMessage('Coach assistance is off.');
      setHint('Turn Coach on to resume position detection.');
      return;
    }
    lastPositionKey = '';
    setMessage('Coach is on. Looking for a chess position...');
    analyzePosition(true);
  }

  hud.querySelector('#pawnforge-approximate').addEventListener('change', () => { lastPositionKey = ''; analyzePosition(true); });
  switchEl.addEventListener('change', () => setActive(switchEl.checked));
  sideEl.addEventListener('change', () => {
    sideMode = sideEl.value;
    persistSettings();
    lastPositionKey = '';
    analyzePosition(true);
  });
  analyzeEl.addEventListener('click', () => analyzePosition(true));
  useFenEl.addEventListener('click', () => {
    const value = normaliseFen(fenEl.value);
    if (!value) {
      setMessage('Enter a complete six-field FEN first.');
      return;
    }
    fenEl.value = value;
    analyzePosition(true);
  });
  saveEndpointEl.addEventListener('click', () => {
    try {
      const value = new URL(endpointEl.value.trim());
      if (value.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(value.hostname) || value.username || value.password || value.pathname !== '/api/analyze/position') throw new Error('Use http://127.0.0.1:PORT/api/analyze/position.');
      endpoint = value.toString();
      endpointEl.value = endpoint;
      persistSettings();
      lastPositionKey = '';
      setMessage('API endpoint saved.');
      analyzePosition(true);
    } catch (error) {
      setMessage(error?.message || 'Enter a valid API endpoint.');
    }
  });
  fenEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') useFenEl.click();
  });

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragInitialLeft = 0;
  let dragInitialTop = 0;
  const header = hud.querySelector('#pawnforge-hud-header');
  header.addEventListener('mousedown', (event) => {
    if (event.target.closest('button, input, select, label')) return;
    dragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    const rect = hud.getBoundingClientRect();
    dragInitialLeft = rect.left;
    dragInitialTop = rect.top;
    event.preventDefault();
  });
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    hud.style.left = `${dragInitialLeft + event.clientX - dragStartX}px`;
    hud.style.top = `${dragInitialTop + event.clientY - dragStartY}px`;
    hud.style.right = 'auto';
    hud.style.bottom = 'auto';
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('scroll', updatePointerPositions, { passive: true });
  window.addEventListener('resize', updatePointerPositions, { passive: true });

  if (extensionRuntime?.onMessage) {
    extensionRuntime.onMessage.addListener((message) => {
      if (message?.type === 'toggle-overlay') setActive(!active);
    });
  }

  loadSettings().finally(() => analyzePosition(true));
  window.setInterval(() => analyzePosition(false), 1500);
})();
