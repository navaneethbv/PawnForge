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

  // A HUD without this world's flag belongs to an orphaned script (for example after the
  // extension reloads); detaching it makes that instance shut itself down.
  existingHud?.remove();
  document.getElementById('pawnforge-style')?.remove();
  document.querySelectorAll('[data-pawnforge-pointer]').forEach((element) => element.remove());

  root.__pawnforge_overlay_loaded = true;

  const DEFAULT_ENDPOINT = 'http://127.0.0.1:4173/api/analyze/position';
  const isExtension = Boolean(root.chrome?.runtime?.id);
  // Reloading or updating the extension orphans this script; its runtime id then disappears.
  const extensionContextAlive = () => {
    try { return Boolean(root.chrome?.runtime?.id); } catch (_error) { return false; }
  };
  const extensionRuntime = isExtension ? root.chrome.runtime : null;
  const extensionStorage = isExtension ? root.chrome.storage?.local : null;

  let active = true;
  let endpoint = DEFAULT_ENDPOINT;
  let sideMode = 'auto';
  // Engine search depth; higher is stronger but slower.
  const DEPTH_CHOICES = [8, 12, 16, 20];
  let depth = DEPTH_CHOICES[0];
  // Candidate lines requested per position (the server allows up to five).
  const CANDIDATE_COUNT = 5;
  // "Weaker moves" suggests a line that gives up this much (centipawns) against the best move:
  // an inaccuracy, never a mistake or blunder.
  const WEAKER_MIN_LOSS_CP = 40;
  const WEAKER_MAX_LOSS_CP = 150;
  let minimized = false;
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
  let pendingForcedAnalysis = false;
  let pollTimer = 0;
  let pointerElements = [];
  // The last analysed position, kept so the next one can be judged as the move that followed it.
  let previousAnalysis = null;
  let verdictMarker = null;

  // A position must read the same on two consecutive polls before it is analysed, which skips
  // mid-animation frames while keeping move-to-analysis latency well under half a second.
  const POLL_INTERVAL_MS = 250;
  const POSITION_STABILITY_MS = 200;

  const style = document.createElement('style');
  style.id = 'pawnforge-style';
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
    #pawnforge-hud-body > label { display: block; margin-top: 4px; }
    #pawnforge-verdict:empty { display: none; }
    #pawnforge-verdict {
      margin-bottom: 8px;
      border-left: 3px solid var(--pawnforge-verdict-color, #4ade80);
      border-radius: 6px;
      padding: 6px 8px;
      background: rgba(255, 255, 255, 0.05);
      color: #e2e8f0;
    }
    .pawnforge-verdict-label { color: var(--pawnforge-verdict-color, #4ade80); font-weight: 700; margin-right: 6px; }
    .pawnforge-verdict-detail { margin-top: 3px; color: #cbd5e1; font-size: 11px; }
    .pawnforge-pointer-verdict {
      border: 3px dashed #f97316;
      border-radius: 8px;
      background: rgba(249, 115, 22, 0.22);
      animation: pawnforge-fade 3.5s ease-out forwards;
    }
    @keyframes pawnforge-fade {
      0%, 70% { opacity: 1; }
      100% { opacity: 0; }
    }
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
    .pawnforge-candidate-list { display: flex; flex-direction: column; gap: 4px; margin-top: 9px; }
    .pawnforge-candidate-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 4px 8px;
      font-size: 11px;
      text-align: left;
    }
    .pawnforge-candidate-rank { width: 20px; color: #94a3b8; }
    .pawnforge-candidate-move { flex: 1 1 auto; font-weight: 600; }
    .pawnforge-candidate-eval { font-variant-numeric: tabular-nums; }
    .pawnforge-candidate-note { color: #fbbf24; font-size: 10px; }
    .pawnforge-header-actions { display: flex; align-items: center; gap: 8px; }
    #pawnforge-minimize {
      width: 24px;
      height: 24px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 6px;
      background: rgba(51, 65, 85, 0.8);
      color: #e2e8f0;
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      line-height: 1;
    }
    #pawnforge-minimize:hover, #pawnforge-minimize:focus-visible { border-color: #22c55e; outline: none; }
    #pawnforge-mini-summary { display: none; color: #f1f5f9; font-size: 12px; font-weight: 600; white-space: nowrap; }
    #pawnforge-hud.pawnforge-minimized { width: auto; max-width: calc(100vw - 32px); padding: 8px 10px; }
    #pawnforge-hud.pawnforge-minimized #pawnforge-hud-header { margin-bottom: 0; }
    #pawnforge-hud.pawnforge-minimized #pawnforge-hud-body { display: none; }
    #pawnforge-hud.pawnforge-minimized #pawnforge-mini-summary:not(:empty) { display: block; }
    #pawnforge-hud.pawnforge-minimized #pawnforge-hud-title-text { display: none; }
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
      <div id="pawnforge-hud-title"><span id="pawnforge-hud-title-mark" aria-hidden="true">♟</span> <span id="pawnforge-hud-title-text">PawnForge Coach</span></div>
      <div id="pawnforge-mini-summary" aria-live="polite"></div>
      <div class="pawnforge-header-actions">
        <label class="pawnforge-toggle" title="Toggle coach assistance">
          <input type="checkbox" id="pawnforge-coach-switch" checked />
          <span class="pawnforge-slider" aria-hidden="true"></span>
          <span>Coach</span>
        </label>
        <button id="pawnforge-minimize" type="button" aria-label="Minimize PawnForge Coach" aria-expanded="true" aria-controls="pawnforge-hud-body" title="Minimize">–</button>
      </div>
    </div>
    <div id="pawnforge-hud-body">
      <div id="pawnforge-verdict" role="status" aria-live="polite"></div>
      <div id="pawnforge-hud-msg" role="status" aria-live="polite">Looking for a chess position...</div>
      <label><input id="pawnforge-approximate" type="checkbox" /> Analyze approximate DOM position (special move rights unknown)</label>
      <label title="Suggest a move that gives up some advantage (an inaccuracy), never a mistake or blunder"><input id="pawnforge-weaker" type="checkbox" /> Suggest weaker moves</label>
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
        <label for="pawnforge-depth">Depth</label>
        <select id="pawnforge-depth" aria-label="Engine search depth">
          <option value="8">8 (fastest)</option>
          <option value="12">12</option>
          <option value="16">16</option>
          <option value="20">20 (strongest)</option>
        </select>
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
  const verdictEl = hud.querySelector('#pawnforge-verdict');
  const candidateEl = hud.querySelector('#pawnforge-hud-candidates');
  const sideEl = hud.querySelector('#pawnforge-side');
  const depthEl = hud.querySelector('#pawnforge-depth');
  const fenEl = hud.querySelector('#pawnforge-fen');
  const analyzeEl = hud.querySelector('#pawnforge-analyze');
  const useFenEl = hud.querySelector('#pawnforge-use-fen');
  const endpointEl = hud.querySelector('#pawnforge-endpoint');
  const saveEndpointEl = hud.querySelector('#pawnforge-save-endpoint');
  const hintEl = hud.querySelector('#pawnforge-hint');
  const approximateEl = hud.querySelector('#pawnforge-approximate');
  const weakerEl = hud.querySelector('#pawnforge-weaker');
  const minimizeEl = hud.querySelector('#pawnforge-minimize');
  const miniSummaryEl = hud.querySelector('#pawnforge-mini-summary');
  endpointEl.value = endpoint;

  function setMessage(text) {
    msgEl.textContent = text;
  }

  function setHint(text) {
    hintEl.textContent = text;
  }

  function removePointers() {
    pointerElements.forEach((element) => element.remove());
    pointerElements = [];
    pointerMove = null;
  }

  function clearVerdict() {
    verdictEl.replaceChildren();
    verdictEl.style.removeProperty('--pawnforge-verdict-color');
    verdictMarker?.remove();
    verdictMarker = null;
  }

  function clearAnalysisUi() {
    activeCandidates = [];
    candidateEl.replaceChildren();
    miniSummaryEl.textContent = '';
    removePointers();
    clearVerdict();
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

  function opposite(color) {
    return color === 'w' ? 'b' : 'w';
  }

  // The highlighted ply in a site's move list is the move that produced the shown position.
  function sideFromSelectedPly() {
    // chess.com: <div class="node white-move selected"> (the highlight may sit on a child span).
    for (const element of document.querySelectorAll('.node.selected, .node .selected, [data-node].selected')) {
      const node = element.closest('.node, [data-node]');
      const classes = classText(node);
      if (/\bwhite-move\b|\bwhite\b/.test(classes)) return 'b';
      if (/\bblack-move\b|\bblack\b/.test(classes)) return 'w';
    }
    // lichess: <l4x><i5z>7</i5z><kwdb class="a1t">h4</kwdb>..., analysis: <index>7.</index><move class="active">.
    const active = document.querySelector('l4x kwdb.a1t, .tview2 move.active');
    const previous = active?.previousElementSibling;
    if (previous) {
      const tag = previous.tagName.toLowerCase();
      if (tag === 'i5z') return 'b';
      if (tag === 'kwdb' || tag === 'move') return 'w';
      if (tag === 'index') return /\.\.\.\s*$/.test(previous.textContent) ? 'w' : 'b';
    }
    return null;
  }

  // Sites highlight the last move's squares; the piece now on them belongs to the side that just moved.
  function sideFromLastMoveHighlight(board, squares) {
    const colors = new Set();
    for (const element of board.element.querySelectorAll('.last-move, .highlight, [class*="last-move" i]')) {
      let square = explicitSquare(element);
      if (!square) {
        const rect = element.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        square = squareFromPoint(board.rect, rect.left + rect.width / 2, rect.top + rect.height / 2, board.orientation);
      }
      const piece = squares.get(square);
      if (piece) colors.add(piece === piece.toUpperCase() ? 'w' : 'b');
    }
    // A user-selected square can carry the same class; conflicting colours mean no answer.
    return colors.size === 1 ? opposite([...colors][0]) : null;
  }

  function sideFromMoveListText() {
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
    const detectors = [
      [() => (sideMode === 'w' || sideMode === 'b' ? sideMode : null), 'chosen manually'],
      [() => sideFromDom(board), 'board attributes'],
      [sideFromSelectedPly, 'move list'],
      [() => sideFromLastMoveHighlight(board, squares), 'last-move highlight'],
      [sideFromRunningClock, 'running clock'],
      [sideFromMoveListText, 'move list']
    ];
    for (const [detect, sideSource] of detectors) {
      const side = detect();
      if (side) return { fen: `${rows.join('/')} ${side} - - 0 1`, board, source: 'approximate visible board', approximate: true, sideSource };
    }
    return { board, sideUnknown: true };
  }

  // lichess (live games): the running clock belongs to the side to move.
  function sideFromRunningClock() {
    const classes = classText(document.querySelector('.rclock.running'));
    if (/\brclock-white\b/.test(classes)) return 'w';
    if (/\brclock-black\b/.test(classes)) return 'b';
    return null;
  }

  function readSameWorldFen() {
    const candidates = [
      typeof root.game?.fen === 'function' ? root.game.fen() : null,
      typeof root.chess?.fen === 'function' ? root.chess.fen() : null,
      root.__PAWNFORGE_FEN__,
      document.querySelector('input#fenInput, input[name="fen"], input.fen')?.value,
      // lichess analysis board: <div class="pair"><label>FEN</label><input class="copyable" value="...">
      ...[...document.querySelectorAll('.pair input.copyable')].map((input) => input.value)
    ];
    return candidates.map(normaliseFen).find(Boolean) || null;
  }

  function readPageFen() {
    const sameWorld = readSameWorldFen();
    if (sameWorld || !isExtension || !extensionRuntime?.sendMessage) return Promise.resolve(sameWorld);
    if (!extensionContextAlive()) {
      shutdown();
      return Promise.resolve(null);
    }
    // Share only an in-flight read; a cached result would hide moves from the next poll.
    if (pageFenPromise) return pageFenPromise;
    pageFenPromise = new Promise((resolve) => {
      try {
        extensionRuntime.sendMessage({ type: 'read-page-fen' }, (response) => {
          if (extensionRuntime.lastError) resolve(null);
          else resolve(normaliseFen(response?.fen));
        });
      } catch (_error) {
        // sendMessage throws synchronously once the extension context is invalidated.
        if (!extensionContextAlive()) shutdown();
        resolve(null);
      }
    }).finally(() => {
      pageFenPromise = null;
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

  function placeOnSquare(element, rect) {
    element.style.left = `${rect.left + 2}px`;
    element.style.top = `${rect.top + 2}px`;
    element.style.width = `${Math.max(0, rect.width - 4)}px`;
    element.style.height = `${Math.max(0, rect.height - 4)}px`;
  }

  function updatePointerPositions() {
    if (!pointerMove && !verdictMarker) return;
    const board = findBoardModel();
    const verdictRect = verdictMarker && squareRect(board, verdictMarker.dataset.square);
    if (verdictRect) placeOnSquare(verdictMarker, verdictRect);
    if (!pointerMove) return;
    const origin = squareRect(board, pointerMove.from);
    const target = squareRect(board, pointerMove.to);
    const [originEl, targetEl] = pointerElements;
    for (const [element, rect] of [[originEl, origin], [targetEl, target]]) {
      if (!element || !rect) continue;
      placeOnSquare(element, rect);
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
    pointerElements = [origin, target];
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

  // Mirrors classify() and LOSS_CLAMP_CP in chess-analysis.js so overlay verdicts match game review.
  const LOSS_CLAMP_CP = 1000;
  const VERDICT_COLORS = { best: '#4ade80', good: '#4ade80', inaccuracy: '#f59e0b', mistake: '#f97316', blunder: '#ef4444' };

  function classifyLoss(deltaCp) {
    if (deltaCp <= 20) return { key: 'best', label: 'Best' };
    if (deltaCp <= 60) return { key: 'good', label: 'Good' };
    if (deltaCp <= 150) return { key: 'inaccuracy', label: 'Inaccuracy' };
    if (deltaCp <= 300) return { key: 'mistake', label: 'Mistake' };
    return { key: 'blunder', label: 'Blunder' };
  }

  function clampEval(cp) {
    return Math.max(-LOSS_CLAMP_CP, Math.min(LOSS_CLAMP_CP, cp));
  }

  function placementSquares(placement) {
    const squares = new Map();
    placement.split('/').forEach((row, rowIndex) => {
      let file = 0;
      for (const token of row) {
        if (/\d/.test(token)) file += Number(token);
        else squares.set(`${String.fromCharCode(97 + file++)}${8 - rowIndex}`, token);
      }
    });
    return squares;
  }

  function pieceColor(piece) {
    if (!piece) return null;
    return piece === piece.toUpperCase() ? 'w' : 'b';
  }

  // Returns the UCI move that turns `beforeFen` into `afterFen`, or null when the two positions
  // are not exactly one move apart (history navigation, a skipped ply, or a misread board).
  function inferPlayedMove(beforeFen, afterFen) {
    const [beforePlacement, mover] = beforeFen.split(' ');
    const [afterPlacement, nextSide] = afterFen.split(' ');
    if (nextSide !== opposite(mover)) return null;
    const before = placementSquares(beforePlacement);
    const after = placementSquares(afterPlacement);
    const vacated = [];
    const arrived = [];
    let capturedElsewhere = 0;
    for (let rank = 1; rank <= 8; rank += 1) {
      for (let file = 0; file < 8; file += 1) {
        const square = `${String.fromCharCode(97 + file)}${rank}`;
        const was = before.get(square);
        const now = after.get(square);
        if (was === now) continue;
        if (pieceColor(was) === mover) vacated.push(square);
        if (pieceColor(now) === mover) arrived.push(square);
        else if (now) return null;
        else if (pieceColor(was) !== mover) capturedElsewhere += 1;
      }
    }
    if (capturedElsewhere > 1) return null;
    if (vacated.length === 1 && arrived.length === 1) {
      const [from] = vacated;
      const [to] = arrived;
      const moved = before.get(from);
      const landed = after.get(to);
      if (moved === landed) return capturedElsewhere && moved.toLowerCase() !== 'p' ? null : `${from}${to}`;
      const promotes = moved.toLowerCase() === 'p' && /[18]$/.test(to) && !capturedElsewhere;
      return promotes ? `${from}${to}${landed.toLowerCase()}` : null;
    }
    if (vacated.length === 2 && arrived.length === 2 && !capturedElsewhere) {
      const kingFrom = vacated.find((square) => before.get(square)?.toLowerCase() === 'k');
      const kingTo = arrived.find((square) => after.get(square)?.toLowerCase() === 'k');
      const rookMoved = vacated.some((square) => before.get(square)?.toLowerCase() === 'r');
      if (kingFrom && kingTo && rookMoved) return `${kingFrom}${kingTo}`;
    }
    return null;
  }

  // Scores the move that led to `snapshot` against the best move found in the previous position.
  function judgePlayedMove(previous, snapshot, data) {
    const uci = inferPlayedMove(previous.fen, snapshot.fen);
    const best = previous.topMoves[0];
    if (!uci || !Number.isFinite(Number(best?.evalCp))) return null;
    const listed = previous.topMoves.find((move) => move.uci === uci);
    let playedCp = Number(listed?.evalCp);
    if (!listed) {
      // Evals are from the side to move, so the reply's best score negated is the mover's score.
      const reply = Number(data.topMoves?.[0]?.evalCp ?? data.bestEvalCp);
      if (!Number.isFinite(reply)) return null;
      playedCp = -reply;
    }
    const bestCp = Number(best.evalCp);
    const deltaCp = Math.max(0, clampEval(bestCp) - clampEval(playedCp));
    const category = uci === best.uci ? classifyLoss(0) : classifyLoss(deltaCp);
    return { uci, mover: previous.fen.split(' ')[1], category, best, bestCp, playedCp };
  }

  function renderVerdict(verdict) {
    clearVerdict();
    if (!verdict) return;
    const moveText = `${verdict.uci.slice(0, 2).toUpperCase()}➜${verdict.uci.slice(2, 4).toUpperCase()}`;
    const moverName = verdict.mover === 'b' ? 'Black' : 'White';
    verdictEl.style.setProperty('--pawnforge-verdict-color', VERDICT_COLORS[verdict.category.key]);
    const headline = document.createElement('div');
    const label = document.createElement('span');
    label.className = 'pawnforge-verdict-label';
    const serious = ['inaccuracy', 'mistake', 'blunder'].includes(verdict.category.key);
    label.textContent = serious ? `⚠ ${verdict.category.label}` : verdict.category.label;
    headline.append(label, `${moverName} played ${moveText}`);
    verdictEl.append(headline);
    if (!serious) return;
    const detail = document.createElement('div');
    detail.className = 'pawnforge-verdict-detail';
    const bestText = `${verdict.best.uci.slice(0, 2).toUpperCase()}➜${verdict.best.uci.slice(2, 4).toUpperCase()}`;
    detail.textContent = `${moverName}'s eval ${formatEvaluation(verdict.bestCp)} → ${formatEvaluation(verdict.playedCp)}. Better was ${bestText}.`;
    verdictEl.append(detail);
    if (verdict.category.key === 'inaccuracy') return;
    verdictMarker = document.createElement('div');
    verdictMarker.className = 'pawnforge-pointer pawnforge-pointer-verdict';
    verdictMarker.dataset.pawnforgePointer = 'verdict';
    verdictMarker.dataset.square = verdict.uci.slice(2, 4);
    verdictMarker.addEventListener('animationend', () => {
      verdictMarker?.remove();
      verdictMarker = null;
    }, { once: true });
    document.body.append(verdictMarker);
    updatePointerPositions();
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
    if (!Number.isInteger(index) || index < 0) return;
    const candidate = activeCandidates.at(index);
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
    const loss = weakerLoss(candidate);
    const advice = loss === null ? 'should move' : `could play a weaker move (about ${(loss / 100).toFixed(1)} pawns below best):`;
    const lineSuffix = moveLine ? ` · ${moveLine}` : '';
    explanation.textContent = `${turn} ${advice} the ${pieceName} on ${from} to ${to}${lineSuffix}`;
    msgEl.append(summary, explanation);
    updateMiniSummary(candidate);
    candidateEl.querySelectorAll('.pawnforge-candidate-pill').forEach((element, candidateIndex) => {
      element.classList.toggle('active', candidateIndex === index);
    });
    renderSquarePointers(candidate.uci.slice(0, 2), candidate.uci.slice(2, 4));
  }

  // Centipawns a candidate gives up against the best line, or null for the best line itself.
  function weakerLoss(candidate) {
    const best = activeCandidates[0];
    if (!weakerEl.checked || !best || candidate === best) return null;
    return Math.max(0, clampEval(Number(best.evalCp)) - clampEval(Number(candidate.evalCp)));
  }

  // The line "Suggest weaker moves" recommends: the biggest loss within the inaccuracy band,
  // else the closest weaker line under the cap, else the best line when every alternative is worse.
  function weakerCandidateIndex(candidates) {
    const bestCp = clampEval(Number(candidates[0]?.evalCp));
    if (!Number.isFinite(bestCp)) return 0;
    let chosen = 0;
    let chosenLoss = -1;
    candidates.forEach((candidate, index) => {
      const loss = bestCp - clampEval(Number(candidate?.evalCp));
      if (index === 0 || !Number.isFinite(loss) || loss > WEAKER_MAX_LOSS_CP) return;
      const inBand = loss >= WEAKER_MIN_LOSS_CP;
      const chosenInBand = chosenLoss >= WEAKER_MIN_LOSS_CP;
      if ((inBand && (!chosenInBand || loss > chosenLoss)) || (!inBand && !chosenInBand && loss > chosenLoss)) {
        chosen = index;
        chosenLoss = loss;
      }
    });
    return chosen;
  }

  function updateMiniSummary(candidate) {
    const move = `${candidate.uci.slice(0, 2).toUpperCase()}➜${candidate.uci.slice(2, 4).toUpperCase()}`;
    const verdictLabel = verdictEl.querySelector('.pawnforge-verdict-label')?.textContent;
    const verdictSuffix = verdictLabel ? ` · ${verdictLabel}` : '';
    miniSummaryEl.textContent = `${move} ${formatEvaluation(candidate.evalCp)}${verdictSuffix}`;
  }

  function renderCandidates(candidates) {
    candidateEl.replaceChildren();
    activeCandidates = Array.isArray(candidates) ? candidates.filter((c) => typeof c?.uci === 'string').slice(0, CANDIDATE_COUNT) : [];
    const suggested = weakerEl.checked ? weakerCandidateIndex(activeCandidates) : 0;
    activeCandidates.forEach((candidate, index) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'pawnforge-candidate-pill';
      const rank = document.createElement('span');
      rank.className = 'pawnforge-candidate-rank';
      rank.textContent = `#${index + 1}`;
      const move = document.createElement('span');
      move.className = 'pawnforge-candidate-move';
      move.textContent = `${candidate.uci.slice(0, 2).toUpperCase()} ➜ ${candidate.uci.slice(2, 4).toUpperCase()}`;
      const evaluation = document.createElement('span');
      evaluation.className = 'pawnforge-candidate-eval';
      evaluation.textContent = formatEvaluation(candidate.evalCp);
      pill.append(rank, move, evaluation);
      if (weakerEl.checked && index === suggested && index > 0) {
        const note = document.createElement('span');
        note.className = 'pawnforge-candidate-note';
        note.textContent = 'suggested';
        pill.append(note);
      }
      pill.addEventListener('click', () => selectCandidate(index));
      candidateEl.appendChild(pill);
    });
    if (activeCandidates.length) selectCandidate(suggested);
  }

  function setMinimized(next) {
    minimized = next;
    hud.classList.toggle('pawnforge-minimized', minimized);
    minimizeEl.textContent = minimized ? '+' : '–';
    minimizeEl.title = minimized ? 'Expand' : 'Minimize';
    minimizeEl.setAttribute('aria-label', minimized ? 'Expand PawnForge Coach' : 'Minimize PawnForge Coach');
    minimizeEl.setAttribute('aria-expanded', String(!minimized));
  }

  async function analyzePosition(force = false, { optIn = false } = {}) {
    if (!active) return;
    if (analysisInFlight) {
      if (force) {
        analysisRequest += 1;
        analysisController?.abort();
        lastPositionKey = '';
        // Re-run once the superseded request settles so a click is never silently dropped.
        pendingForcedAnalysis = true;
      }
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

    if (snapshot.approximate && !approximateEl.checked) {
      if (optIn) {
        // Pressing Analyze on a DOM-only board is an explicit request for approximate analysis.
        approximateEl.checked = true;
        editedSettings.add('approximate');
        persistSettings();
      } else {
        lastPositionKey = '';
        currentSnapshot = snapshot;
        clearAnalysisUi();
        setMessage('Board found. Press Analyze to use the visible pieces, or paste a full FEN.');
        setHint('DOM pieces do not reveal castling, en passant, or draw counters, so live analysis waits for you to opt in.');
        return;
      }
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
      const payload = { fen: snapshot.fen, settings: { depth, multiPv: CANDIDATE_COUNT } };
      let data;
      if (isExtension) {
        if (!extensionContextAlive()) {
          shutdown();
          return;
        }
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
      const verdict = previousAnalysis && judgePlayedMove(previousAnalysis, snapshot, data);
      const hasMoves = Array.isArray(data.topMoves) && data.topMoves.length > 0;
      previousAnalysis = hasMoves ? { fen: snapshot.fen, topMoves: data.topMoves } : null;
      if (!hasMoves) {
        setMessage('The engine returned no legal moves for this position.');
        renderVerdict(verdict);
        return;
      }
      renderVerdict(verdict);
      renderCandidates(data.topMoves);
      const turn = snapshot.fen.split(' ')[1] === 'b' ? 'Black' : 'White';
      setHint(snapshot.approximate ? `Approximate: ${turn} to move (${snapshot.sideSource}); castling and en passant disabled; draw counters unknown. Paste a full FEN for accurate results.` : `Source: ${snapshot.source || 'position'}. Select a line to move the highlights.`);
    } catch (error) {
      if (isExtension && !extensionContextAlive()) {
        shutdown();
        return;
      }
      if (error?.name === 'AbortError' || requestId !== analysisRequest) return;
      lastPositionKey = '';
      clearAnalysisUi();
      setMessage('Engine unavailable. Start PawnForge and check the endpoint.');
      setHint(error?.message || endpoint);
    } finally {
      analysisInFlight = false;
      if (pendingForcedAnalysis && active) {
        pendingForcedAnalysis = false;
        void analyzePosition(true);
      }
    }
  }

  // Settings the user changes before storage finishes loading must not be overwritten by it.
  const editedSettings = new Set();

  // Only the loopback analysis endpoint is accepted, whether it comes from storage or the API field.
  function parseLocalEndpoint(value) {
    let url;
    try {
      url = new URL(String(value).trim());
    } catch (_error) {
      return null;
    }
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    return local && !url.username && !url.password && url.pathname === '/api/analyze/position' ? url : null;
  }

  const isBoolean = (value) => typeof value === 'boolean';

  async function loadSettings() {
    if (!extensionStorage) return;
    try {
      const stored = await extensionStorage.get(['endpoint', 'sideMode', 'approximate', 'depth', 'weaker', 'minimized']);
      // A stored value applies only when it is valid and the user has not changed that setting meanwhile.
      const apply = (key, isValid, set) => {
        if (!editedSettings.has(key) && isValid(stored[key])) set(stored[key]);
      };
      apply('endpoint', (value) => typeof value === 'string' && parseLocalEndpoint(value) !== null, (value) => { endpoint = parseLocalEndpoint(value).toString(); });
      apply('sideMode', (value) => ['w', 'b', 'auto'].includes(value), (value) => { sideMode = value; });
      apply('approximate', isBoolean, (value) => { approximateEl.checked = value; });
      apply('weaker', isBoolean, (value) => { weakerEl.checked = value; });
      apply('minimized', isBoolean, setMinimized);
      apply('depth', (value) => DEPTH_CHOICES.includes(value), (value) => { depth = value; });
      sideEl.value = sideMode;
      depthEl.value = String(depth);
      if (!editedSettings.has('endpointField')) endpointEl.value = endpoint;
    } catch (_error) {
      setHint('Using the default local PawnForge endpoint.');
    }
  }

  function persistSettings() {
    if (!extensionStorage || !extensionContextAlive()) return;
    try {
      extensionStorage.set({ endpoint, sideMode, depth, minimized, approximate: approximateEl.checked, weaker: weakerEl.checked }).catch(() => {});
    } catch (_error) {
      // The extension was reloaded; the next poll shuts this orphaned instance down.
    }
  }

  function onViewportChange() {
    updatePointerPositions();
  }

  function onMouseMove(event) {
    if (!dragging) return;
    hud.style.left = `${dragInitialLeft + event.clientX - dragStartX}px`;
    hud.style.top = `${dragInitialTop + event.clientY - dragStartY}px`;
    hud.style.right = 'auto';
    hud.style.bottom = 'auto';
  }

  function onMouseUp() {
    dragging = false;
  }

  // Stops an instance whose extension context died or whose HUD was replaced by a newer instance.
  function shutdown() {
    if (!pollTimer && !hud.isConnected) return;
    active = false;
    analysisRequest += 1;
    analysisController?.abort();
    window.clearInterval(pollTimer);
    pollTimer = 0;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('scroll', onViewportChange);
    window.removeEventListener('resize', onViewportChange);
    removePointers();
    clearVerdict();
    if (hud.isConnected) {
      hud.remove();
      style.remove();
      root.__pawnforge_overlay_loaded = false;
    }
  }

  function setActive(next) {
    active = next;
    switchEl.checked = active;
    if (!active) {
      analysisRequest += 1;
      if (analysisController) analysisController.abort();
      previousAnalysis = null;
      clearAnalysisUi();
      setMessage('Coach assistance is off.');
      setHint('Turn Coach on to resume position detection.');
      return;
    }
    lastPositionKey = '';
    setMessage('Coach is on. Looking for a chess position...');
    void analyzePosition(true);
  }

  approximateEl.addEventListener('change', () => {
    editedSettings.add('approximate');
    persistSettings();
    lastPositionKey = '';
    void analyzePosition(true);
  });
  switchEl.addEventListener('change', () => setActive(switchEl.checked));
  minimizeEl.addEventListener('click', () => {
    setMinimized(!minimized);
    editedSettings.add('minimized');
    persistSettings();
  });
  weakerEl.addEventListener('change', () => {
    editedSettings.add('weaker');
    persistSettings();
    // Re-rank the lines already on screen; no new engine request is needed.
    if (activeCandidates.length) renderCandidates(activeCandidates);
  });
  sideEl.addEventListener('change', () => {
    sideMode = sideEl.value;
    editedSettings.add('sideMode');
    persistSettings();
    lastPositionKey = '';
    void analyzePosition(true);
  });
  depthEl.addEventListener('change', () => {
    const value = Number(depthEl.value);
    if (!DEPTH_CHOICES.includes(value)) return;
    depth = value;
    editedSettings.add('depth');
    persistSettings();
    // Evaluations from different depths are not comparable, so start a fresh move history.
    previousAnalysis = null;
    lastPositionKey = '';
    void analyzePosition(true);
  });
  analyzeEl.addEventListener('click', () => analyzePosition(true, { optIn: true }));
  useFenEl.addEventListener('click', () => {
    const value = normaliseFen(fenEl.value);
    if (!value) {
      setMessage('Enter a complete six-field FEN first.');
      return;
    }
    fenEl.value = value;
    void analyzePosition(true);
  });
  endpointEl.addEventListener('input', () => editedSettings.add('endpointField'));
  saveEndpointEl.addEventListener('click', () => {
    try {
      const value = parseLocalEndpoint(endpointEl.value);
      if (!value) throw new Error('Use http://127.0.0.1:PORT/api/analyze/position.');
      endpoint = value.toString();
      endpointEl.value = endpoint;
      editedSettings.add('endpoint');
      persistSettings();
      lastPositionKey = '';
      setMessage('API endpoint saved.');
      void analyzePosition(true);
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
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('scroll', onViewportChange, { passive: true });
  window.addEventListener('resize', onViewportChange, { passive: true });

  if (extensionRuntime?.onMessage) {
    extensionRuntime.onMessage.addListener((message) => {
      if (message?.type === 'toggle-overlay') setActive(!active);
    });
  }

  void loadSettings().finally(() => { void analyzePosition(true); });
  pollTimer = window.setInterval(() => {
    if (!hud.isConnected || (isExtension && !extensionContextAlive())) shutdown();
    else void analyzePosition(false);
  }, POLL_INTERVAL_MS);
})();
