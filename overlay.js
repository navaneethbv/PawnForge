/**
 * PawnForge Web Overlay (Coach & Move Assistant)
 * 
 * Embed on your personal website or use as a browser bookmarklet:
 * <script src="http://localhost:4173/overlay.js"></script>
 * 
 * Features:
 * - Floating, draggable Coach HUD with an On/Off toggle
 * - Visual highlight pointers (pulsing origin + target ring) on the board
 * - Top candidate moves with evaluations
 * - Works from opening, middlegame, or endgame
 */
(() => {
  if (window.__pawnforge_overlay_loaded) {
    const hud = document.getElementById('pawnforge-hud');
    if (hud) hud.style.display = hud.style.display === 'none' ? 'block' : 'none';
    return;
  }
  window.__pawnforge_overlay_loaded = true;

  const API_ENDPOINT = 'http://localhost:4173/api/analyze/position';
  let active = true;
  let lastFen = '';
  let activeCandidates = [];

  // ── Styles ──
  const style = document.createElement('style');
  style.textContent = `
    #pawnforge-hud {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 300px;
      background: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(34, 197, 94, 0.4);
      border-radius: 12px;
      padding: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
      z-index: 9999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e2e8f0;
      user-select: none;
    }
    #pawnforge-hud-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      cursor: move;
    }
    #pawnforge-hud-title {
      font-size: 13px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
      color: #fff;
    }
    .pawnforge-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      cursor: pointer;
    }
    .pawnforge-toggle input { display: none; }
    .pawnforge-slider {
      position: relative;
      width: 28px;
      height: 16px;
      background: #374151;
      border-radius: 16px;
      transition: 0.2s;
    }
    .pawnforge-slider:before {
      content: "";
      position: absolute;
      width: 12px;
      height: 12px;
      left: 2px;
      bottom: 2px;
      background: #fff;
      border-radius: 50%;
      transition: 0.2s;
    }
    .pawnforge-toggle input:checked + .pawnforge-slider { background: #22c55e; }
    .pawnforge-toggle input:checked + .pawnforge-slider:before { transform: translateX(12px); }
    #pawnforge-hud-body { font-size: 12px; line-height: 1.4; color: #94a3b8; }
    .pawnforge-move-tag {
      font-weight: 700;
      color: #22c55e;
      background: rgba(34, 197, 94, 0.18);
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 14px;
      display: inline-block;
      margin-right: 6px;
    }
    .pawnforge-eval-tag {
      font-size: 12px;
      font-weight: 600;
      background: rgba(255,255,255,0.1);
      padding: 2px 6px;
      border-radius: 4px;
      color: #f1f5f9;
    }
    .pawnforge-candidate-list {
      display: flex;
      gap: 5px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .pawnforge-candidate-pill {
      font-size: 11px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 4px;
      padding: 2px 6px;
      color: #cbd5e1;
      cursor: pointer;
    }
    .pawnforge-candidate-pill:hover, .pawnforge-candidate-pill.active {
      background: rgba(34, 197, 94, 0.2);
      border-color: #22c55e;
      color: #fff;
    }

    /* Square Visual Pointers */
    .pawnforge-pointer-origin {
      position: absolute;
      inset: 2px;
      border: 3px solid #22c55e !important;
      border-radius: 8px !important;
      box-shadow: 0 0 16px rgba(34, 197, 94, 0.8), inset 0 0 10px rgba(34, 197, 94, 0.3) !important;
      pointer-events: none !important;
      z-index: 99999 !important;
      animation: pfPulse 1.4s infinite alternate ease-in-out !important;
    }
    .pawnforge-pointer-target {
      position: absolute;
      inset: 4px;
      border: 3px dashed #10b981 !important;
      border-radius: 50% !important;
      background: rgba(16, 185, 129, 0.25) !important;
      box-shadow: 0 0 16px rgba(16, 185, 129, 0.8) !important;
      pointer-events: none !important;
      z-index: 99999 !important;
      animation: pfSpin 6s linear infinite !important;
    }
    @keyframes pfPulse {
      0% { transform: scale(0.96); opacity: 0.8; }
      100% { transform: scale(1.04); opacity: 1; }
    }
    @keyframes pfSpin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);

  // ── HUD Container ──
  const hud = document.createElement('div');
  hud.id = 'pawnforge-hud';
  hud.innerHTML = `
    <div id="pawnforge-hud-header">
      <div id="pawnforge-hud-title">
        <span>&#9823;</span> PawnForge Coach
      </div>
      <label class="pawnforge-toggle" title="Toggle Coach Help On/Off">
        <input type="checkbox" id="pawnforge-coach-switch" checked />
        <span class="pawnforge-slider"></span>
      </label>
    </div>
    <div id="pawnforge-hud-body">
      <div id="pawnforge-hud-msg">Ready. Monitoring board...</div>
      <div id="pawnforge-hud-candidates" class="pawnforge-candidate-list"></div>
    </div>
  `;
  document.body.appendChild(hud);

  const switchEl = document.getElementById('pawnforge-coach-switch');
  const msgEl = document.getElementById('pawnforge-hud-msg');
  const candEl = document.getElementById('pawnforge-hud-candidates');

  switchEl.addEventListener('change', (e) => {
    active = e.target.checked;
    if (!active) {
      msgEl.innerHTML = '<span style="color:#64748b;">Coach assistance is OFF.</span>';
      candEl.innerHTML = '';
      removePointers();
    } else {
      msgEl.textContent = 'Coach is ON. Evaluating...';
      lastFen = '';
      checkBoard();
    }
  });

  // Dragging support
  let isDragging = false, startX, startY, initX, initY;
  const header = document.getElementById('pawnforge-hud-header');
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.pawnforge-toggle')) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = hud.getBoundingClientRect();
    initX = rect.left;
    initY = rect.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    hud.style.left = `${initX + (e.clientX - startX)}px`;
    hud.style.top = `${initY + (e.clientY - startY)}px`;
    hud.style.bottom = 'auto';
    hud.style.right = 'auto';
  });
  window.addEventListener('mouseup', () => { isDragging = false; });

  function removePointers() {
    document.querySelectorAll('.pawnforge-pointer-origin, .pawnforge-pointer-target').forEach((el) => el.remove());
  }

  // Find DOM square element on host chessboard
  function findSquareElement(sq) {
    sq = sq.toLowerCase();
    const selectors = [
      `.square-${sq}`,
      `[data-square="${sq}"]`,
      `[data-piece-target="${sq}"]`,
      `square.${sq}`
    ];
    for (const sel of selectors) {
      const found = document.querySelector(sel);
      if (found) return found;
    }
    return null;
  }

  function renderSquarePointers(from, to) {
    removePointers();
    const fromEl = findSquareElement(from);
    const toEl = findSquareElement(to);

    if (fromEl) {
      const pOrigin = document.createElement('div');
      pOrigin.className = 'pawnforge-pointer-origin';
      fromEl.style.position = 'relative';
      fromEl.appendChild(pOrigin);
    }
    if (toEl) {
      const pTarget = document.createElement('div');
      pTarget.className = 'pawnforge-pointer-target';
      toEl.style.position = 'relative';
      toEl.appendChild(pTarget);
    }
  }

  // Detect board FEN from common webpage chessboards
  function detectCurrentFen() {
    if (window.game && typeof window.game.fen === 'function') {
      return window.game.fen();
    }
    const fenInput = document.querySelector('input#fenInput, input[name="fen"], input.fen');
    if (fenInput && fenInput.value && fenInput.value.includes('/')) {
      return fenInput.value.trim();
    }
    return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  }

  function selectCandidate(idx) {
    if (!activeCandidates || !activeCandidates[idx]) return;
    const top = activeCandidates[idx];
    const from = top.uci.substring(0, 2);
    const to = top.uci.substring(2, 4);
    const evalScore = (top.evalCp / 100).toFixed(2);
    const evalTag = top.evalCp >= 0 ? `+${evalScore}` : evalScore;
    const turn = lastFen.split(' ')[1] === 'w' ? 'White' : 'Black';

    msgEl.innerHTML = `
      <div style="margin-bottom:6px;">
        <span class="pawnforge-move-tag">${from.toUpperCase()} ➔ ${to.toUpperCase()}</span>
        <span class="pawnforge-eval-tag">${evalTag}</span>
      </div>
      <div style="font-size:11px;color:#cbd5e1;line-height:1.4;">
        👉 <strong>${turn}</strong> moves piece on <strong>${from.toUpperCase()}</strong> to <strong>${to.toUpperCase()}</strong><br>
        Line: <em>${top.pv.split(' ').slice(0, 4).join(' ')}</em>
      </div>
    `;

    document.querySelectorAll('.pawnforge-candidate-pill').forEach((p, i) => {
      p.classList.toggle('active', i === idx);
    });

    renderSquarePointers(from, to);
  }

  async function checkBoard() {
    if (!active) return;
    const fen = detectCurrentFen();
    if (fen === lastFen) return;
    lastFen = fen;

    try {
      const res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen, settings: { depth: 10, multiPv: 3 } })
      });
      if (!res.ok) throw new Error('Engine offline');
      const data = await res.json();
      if (!active) return;

      if (data.topMoves && data.topMoves.length > 0) {
        activeCandidates = data.topMoves;
        candEl.innerHTML = '';
        activeCandidates.forEach((c, i) => {
          const pill = document.createElement('button');
          pill.className = 'pawnforge-candidate-pill' + (i === 0 ? ' active' : '');
          const uciFrom = c.uci.substring(0, 2).toUpperCase();
          const uciTo = c.uci.substring(2, 4).toUpperCase();
          const score = (c.evalCp / 100).toFixed(1);
          pill.textContent = `#${i + 1} ${uciFrom}-${uciTo} (${c.evalCp >= 0 ? '+' : ''}${score})`;
          pill.addEventListener('click', () => selectCandidate(i));
          candEl.appendChild(pill);
        });

        selectCandidate(0);
      }
    } catch (_e) {
      msgEl.textContent = 'Engine unreachable.';
      removePointers();
    }
  }

  // Periodic position polling
  setInterval(checkBoard, 1000);
  checkBoard();
})();
