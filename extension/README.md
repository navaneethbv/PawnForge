# PawnForge Coach Overlay

The repository root is a Manifest V3 Chrome extension as well as the PawnForge web app.

## Developer mode setup

1. Start the local PawnForge server with `npm start`.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the repository root, `/Users/navaneethbv/Desktop/Projects/PawnForge`.
5. Open a chess site and use the PawnForge Coach panel or the extension toolbar button.

The extension calls `http://127.0.0.1:4173` by default.
If the server uses another port, update the API field in the overlay and choose Save.

## How position detection works

PawnForge first asks the page for a full FEN through a Chrome main-world bridge.
If the page does not expose one, it reads visible pieces from common DOM chessboard structures.
Auto detect uses turn metadata when available and falls back to the bottom move-list row: a complete white and black pair means White moves next, while a row containing only White's move means Black moves next.
The overlay waits for a stable board snapshot and never overlaps engine requests while a previous analysis is running.
The Side selector and manual FEN field cover sites that hide that state.

The overlay can render red origin and destination pointers over any visible square-based or DOM-backed chessboard.
A canvas-only board without a page FEN needs a manually pasted FEN because browser content scripts cannot reliably recover hidden canvas state.

## Scope and privacy

The extension needs access to the page so it can read the current board and draw the next-move pointers.
Position data is sent only to the configured local PawnForge server.
The extension does not click pieces or submit moves.
