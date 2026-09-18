# PawnForge

PawnForge is a full-stack, anonymous chess analysis web app with a self-hosted Stockfish engine. Inspired by ChessFish-style workflows: move-by-move analysis, blunder detection, opening insights, and a signature "evaluate every legal move" explorer.

## Features

### Position Analysis
- Multi-PV Stockfish analysis with configurable depth (8-20)
- Eval bar visualization showing white/black advantage
- Top engine lines with evaluation scores

### Evaluate Every Legal Move (Signature Feature)
- Evaluates all legal moves in any position via streaming SSE
- Piece badges: each piece type shows its best available move with quality indicator
- Global move table: sort by evaluation, delta from best, or piece type
- Filter by captures, checks, or all moves
- Real-time progress as moves are evaluated

### PGN Game Review
- Upload/paste PGN to analyze a complete game
- Evaluation graph (canvas) with clickable navigation
- Move-by-move annotations with quality classification
- Navigate with arrow keys, buttons, or click the eval graph
- Game summary with ACPL (average centipawn loss) per side
- Turning point detection (mistakes and blunders highlighted)

### Opening Discovery
- Detects openings from the current move sequence
- ECO code identification
- Book window range
- Common continuations with clickable moves

### Move Quality Classification
| Category   | Delta (cp) | Color  |
|------------|------------|--------|
| Best       | 0-20       | Blue   |
| Good       | 20-60      | Green  |
| Inaccuracy | 60-150     | Orange |
| Mistake    | 150-300    | Red    |
| Blunder    | >300       | Red    |

## Architecture

```
Frontend (vanilla JS + chess.js + chessboardjs)
  |
  v
Node.js HTTP Server (server.js)
  |
  ├── Static file serving
  ├── API endpoints (JSON over HTTP)
  └── Engine Pool (Stockfish UCI workers)
        |
        v
      Stockfish binary (engine/Stockfish/src/stockfish)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/analyze/position` | POST | Analyze position with MultiPV |
| `/api/analyze/all-moves` | POST | Stream eval for every legal move (SSE) |
| `/api/analyze/game` | POST | Full game review from PGN |
| `/api/opening` | GET | Detect opening by move sequence |
| `/api/status` | GET | Engine and server status |

## How to Run

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js     | 22+     | Runtime uses built-in modules; `npm ci` installs test tools |
| C++ compiler | g++ or clang++ | Required to build Stockfish from source |
| make        | any     | Build tool for Stockfish |

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/navaneethbv/PawnForge.git
cd PawnForge

# 2. Build Stockfish (or use pre-built binary if present)
cd engine/Stockfish/src
# On Linux:
make -j$(nproc) build ARCH=x86-64-modern
# On macOS (Apple Silicon):
make -j$(sysctl -n hw.ncpu) build ARCH=apple-silicon
cd ../../..

# 3. Start the server
npm start
```

Open **http://localhost:4173** in your browser.

### Build Stockfish

The engine source is included under `engine/Stockfish/` (Stockfish 19). Build it for your platform:

```bash
cd engine/Stockfish/src

# On macOS (Apple Silicon):
make -j$(sysctl -n hw.ncpu) build ARCH=apple-silicon

# On Linux (modern x86_64):
make -j$(nproc) build ARCH=x86-64-modern
```

Common `ARCH` values:

| ARCH | Description |
|------|-------------|
| `apple-silicon` | Apple Silicon chips (M1/M2/M3/M4) |
| `x86-64-modern` | 64-bit with POPCNT (most CPUs from ~2008+) |
| `x86-64-avx2` | 64-bit with AVX2 (Intel Haswell+ / AMD Excavator+) |
| `x86-64` | Generic 64-bit x86 |
| `armv8` | 64-bit ARM (Raspberry Pi 4, etc.) |

Run `make help` inside `engine/Stockfish/src` for the full list.

After building, verify the binary works:

```bash
echo "quit" | ./engine/Stockfish/src/stockfish
# Expected: "Stockfish 19 by the Stockfish developers ..."
```

### Using a System-Installed Stockfish

If you already have Stockfish installed (e.g. via `apt install stockfish` or `brew install stockfish`), you can skip the build step. The server auto-detects it in this order:

1. `STOCKFISH_BIN` environment variable (if set)
2. `engine/Stockfish/src/stockfish` (or `stockfish-macos-universal`)
3. `/usr/games/stockfish` (Debian/Ubuntu package location)
4. `/usr/local/bin/stockfish` or `/opt/homebrew/bin/stockfish`
5. `stockfish` on `PATH`

To point at a specific binary:

```bash
STOCKFISH_BIN=/path/to/stockfish npm start
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4173` | HTTP server port |
| `STOCKFISH_BIN` | auto-detect | Path to Stockfish binary |

### Running on a Custom Port

```bash
PORT=8080 npm start
```

### Testing Locally

Once the server is running, you can verify the API from the command line:

```bash
# Check engine status
curl http://localhost:4173/api/status

# Analyze the starting position
curl -X POST http://localhost:4173/api/analyze/position \
  -H "Content-Type: application/json" \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1","settings":{"depth":10,"multiPv":3}}'

# Detect an opening
curl "http://localhost:4173/api/opening?moves=e4+e5+Nf3+Nc6+Bb5"
```

### Testing in the Browser

1. **Analyze tab** - The board loads at the starting position. Drag pieces to make moves, then click "Analyze Position" to see engine evaluation with PV lines.

2. **Game Review tab** - Paste a PGN (e.g. from lichess or chess.com), click "Analyze Game". The eval graph renders and you can step through moves with arrow keys or by clicking the graph.

3. **Move Explorer tab** - Click "Run All-Moves Explorer" to evaluate every legal move in the current position. Watch the streaming progress bar, then inspect piece badges and the ranked move table.

4. **Openings tab** - Play a few opening moves on the board, then click "Detect Opening" to see the ECO code, name, and suggested continuations.

### Chrome Coach Overlay

The repository root also contains a Manifest V3 Chrome extension.
Start PawnForge with `npm start`, open `chrome://extensions`, enable Developer mode, and load this repository directory as an unpacked extension.
The Coach overlay runs on HTTP and HTTPS chess sites and prefers a complete page FEN.
It calls the local Stockfish API through the extension background worker and highlights the recommended origin and destination squares in red.
DOM-only reconstruction requires opting into approximate analysis because visible pieces do not reveal castling rights, en passant, or draw counters.
Auto detect uses the site's turn metadata when available and falls back to the bottom move-list row, so a completed white and black pair means White moves next while a row containing only White's move means Black moves next.
Paste a complete six-field FEN for accurate analysis when the page does not expose one.
The Side selector is available for approximate DOM analysis.
Canvas-only boards need a page FEN or manual FEN.
The API field supports a different local server port.

See [extension/README.md](extension/README.md) for setup and detection details.

### macOS companion

The `macos/` Swift package provides a menu bar launcher for the local PawnForge server.
It starts and stops Node.js, opens the web app, and opens Chrome's extension manager.
Chrome remains responsible for reading the active page and drawing the overlay through its extension permission model.

Run it from the repository with `swift run --package-path macos -- --repo /Users/navaneethbv/Desktop/Projects/PawnForge`.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| `Stockfish is not available` | Build the engine (`cd engine/Stockfish/src && make build ARCH=x86-64`) or install it system-wide |
| `Engine timeout` errors | Reduce analysis depth, retry after queued work completes, or check that the Stockfish binary runs correctly (`echo "quit" \| stockfish`) |
| Port already in use | Set a different port: `PORT=3000 npm start` |
| Board doesn't render | Ensure you have internet access (chessboard.js and chess.js load from CDN) |

## Engine Configuration

The engine pool starts up to four Stockfish UCI workers on demand, capped at the CPU count.
Each worker allows at most eight outstanding jobs and has a 15-second deadline measured from enqueue time.
Overload returns HTTP 429; expired queued jobs return HTTP 503.
Crashed, timed-out, and cancelled workers are terminated and replaced on the next job.
Disconnected clients cancel their queued or active work, and each API request has a two-minute deadline.
Streaming failures are sent as SSE error events.
Shutdown terminates the engine children.
An LRU cache holds up to 500 results for one hour.

The server listens only on `127.0.0.1` and accepts local Host headers.
Browser API requests are restricted to the local app origins and Chrome extension origins.
The API does not grant cross-origin website access with CORS headers; the extension uses its host permission.
Requests without Origin remain available to local command-line clients.
This is a local application, not an authenticated public hosting service.
Cross-site bookmarklet injection cannot call the API; use the Chrome extension instead.

## Automated verification

```bash
npm ci
npx playwright install chromium
npm run check
npm test
npm run test:browser
npm audit --audit-level=high
swift build --package-path macos # macOS only
```

Browser tests require an installed or built Stockfish binary and reserve port 4189.
They serve pinned test copies of the frontend libraries so the tests do not depend on CDN availability.
The application still loads those libraries from CDNs.
Worker tests use a controlled UCI process to exercise crashes, continuous-output timeouts, cancellation, and overload.
Browser tests cover FEN loading, illegal drags, history, stale sparring/review responses, custom-position summaries, API access restrictions, and real-engine analysis/explorer results.
GitHub Actions runs JavaScript checks, tests, a dependency audit, and the macOS build.
Native menu interaction and third-party chess-site compatibility remain manual checks.

## Position and review behavior

Loading a FEN updates the board only after validation succeeds.
History navigation replays moves to retain opening and repetition history in the frontend.
FEN-only engine analysis cannot recover repetition history from earlier positions.
Game review preserves the PGN starting position, side to move, and move numbers.
Starting a newer review cancels the previous request and keeps its response and position sequence together.
Resetting, loading a FEN, changing sides, or disabling sparring invalidates pending computer moves.

## Tech Stack

- **Frontend**: Vanilla JS (ES modules), chess.js, chessboardjs, Canvas API
- **Backend**: Node.js (zero npm dependencies, built-in modules only)
- **Engine**: Stockfish 19 (compiled from source)
- **Protocol**: UCI over stdin/stdout, SSE for streaming

## License

### PawnForge application

The PawnForge application source code in this repository (excluding the bundled Stockfish engine under `engine/Stockfish`) is licensed under the **Apache License, Version 2.0**.

See the top-level `LICENSE` file for the full text of the Apache-2.0 license.

### Stockfish engine

This repository vendors the **Stockfish** chess engine in `engine/Stockfish`. Stockfish is licensed under the **GNU General Public License, version 3 (GPL-3.0)**.

The applicable license terms for Stockfish are provided by the upstream project and included here in `engine/Stockfish/Copying.txt` (and any other license files in that directory). Those terms apply to the Stockfish source code and any binaries built from it.

### Distribution considerations

If you distribute PawnForge together with the bundled Stockfish binary (or a modified version of Stockfish), that distribution must comply with the **GPL-3.0** for the Stockfish component. Among other things, this typically means:

- Preserving Stockfish copyright and license notices.
- Providing (or offering) the corresponding source code for the Stockfish binary you distribute.
- Ensuring that the terms under which you distribute Stockfish are compatible with the GPL-3.0.

Using a system-installed Stockfish instead of the bundled one does not remove these obligations; you must still comply with the license of whatever Stockfish binary you use.

Nothing in this README modifies the terms of the Apache-2.0 license for PawnForge's own code or the GPL-3.0 license for Stockfish; downstream users are responsible for ensuring their own compliance when redistributing this software.
