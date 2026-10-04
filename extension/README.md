# PawnForge Coach Overlay

The repository root is a Manifest V3 Chrome extension as well as the PawnForge web app.

## Developer mode setup

1. Start the local PawnForge server with `npm start`.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the repository root (the folder containing `manifest.json`).
5. Open Chess.com, Lichess, ChessTempo, or chess.org and use the PawnForge Coach panel or the extension toolbar button.

The extension background worker calls `http://127.0.0.1:4173` by default.
Only HTTP loopback endpoints with the `/api/analyze/position` path are accepted.
If the server uses another port, update the API field in the overlay and choose Save.

## How position detection works

PawnForge first asks the page for a full FEN through a Chrome main-world bridge.
On chess.com it reads the board element's game object, and on the lichess analysis board it reads the FEN field, so both give exact positions including castling and en passant.
If the page does not expose a complete six-field FEN, it reads visible pieces from common DOM chessboard structures.
This reconstruction is incomplete: it cannot recover castling rights, en passant targets, or draw counters.
Paste a full FEN for accurate analysis, or explicitly select **Analyze approximate DOM position** to analyze with special move rights disabled.
The panel keeps an approximation warning visible with those results.
Auto detect uses turn metadata, the selected move-list entry, the last-move highlight, or a running lichess clock, and falls back to the bottom move-list row: a complete white and black pair means White moves next, while a row containing only White's move means Black moves next.
Live lichess games do not expose a FEN, so they use this approximate path.
The overlay waits for a stable board snapshot and cancels a pending search when the position or settings change, or Coach is turned off.
Cancellation is relayed to the local server and scoped to that tab and request.
The Side selector sets the side to move for approximate DOM analysis when Auto detect gets it wrong; it is the side to move, not your colour, so it applies to the current position only and returns to Auto detect after the next move.
Evaluations are shown from White's point of view, like the lichess and chess.com eval bars.
When a page has several boards or wraps its board in other elements, the overlay prefers the largest innermost board containing pieces.
A smaller board with more pieces cannot displace the main endgame board.
Highlights stay attached to the board used for that analysis, including when viewed from Black.
A manual FEN takes precedence and supplies all six fields.
The panel lists the five best engine moves, best first; select one to move the board highlights.
The minimize button collapses the panel to a one-line bar that keeps analysing, highlights the suggested move on the board, and shows it with the last move's verdict.
**Suggest weaker moves** selects the line with the largest loss between 0.4 and 1.5 pawns against the best move; if none qualifies it takes the closest weaker line under 1.5 pawns, and otherwise the best move.
Both settings are remembered.
The Depth selector sets the engine search depth (8, 12, 16 or 20); changing it starts a fresh blunder-detector history because evaluations from different depths are not comparable.

The overlay can render red origin and destination pointers over any visible square-based or DOM-backed chessboard.
A canvas-only board without a page FEN needs a manually pasted FEN because browser content scripts cannot reliably recover hidden canvas state.

## Scope and privacy

Automatic injection and page access are limited to Chess.com, Lichess, ChessTempo, and chess.org, including their subdomains.
The extension toolbar also respects this allowlist.
Chess.com and Lichess have site-specific readers; ChessTempo and chess.org use generic DOM detection or a manually pasted FEN.
Live compatibility with every page on those sites is not guaranteed.
Only loopback server access is granted in addition to those chess domains, including custom local ports.
Position data is sent only to the configured loopback PawnForge endpoint through the extension background worker.
The relay rejects remote endpoints and limits each analysis request to 20 seconds.
The local server rejects API calls from arbitrary website origins; use the extension instead of cross-site script injection.
The extension does not click pieces or submit moves.
