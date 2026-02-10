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
| Node.js     | 18+     | Only built-in modules are used (no `npm install` needed) |
| C++ compiler | g++ or clang++ | Required to build Stockfish from source |
| make        | any     | Build tool for Stockfish |

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/navaneethbv/PawnForge.git
cd PawnForge

# 2. Build Stockfish (one-time step)
cd engine/Stockfish/src
make -j$(nproc) build ARCH=x86-64
cd ../../..

# 3. Start the server
npm start
```

Open **http://localhost:4173** in your browser.

### Build Stockfish

The engine source is included under `engine/Stockfish/`. Build it for your platform:

```bash
cd engine/Stockfish/src
make -j$(nproc) build ARCH=x86-64
```

Common `ARCH` values:

| ARCH | Description |
|------|-------------|
| `x86-64` | 64-bit x86 (most Linux/macOS/WSL systems) |
| `x86-64-modern` | 64-bit with POPCNT (most CPUs from ~2008+) |
| `x86-64-avx2` | 64-bit with AVX2 (Intel Haswell+ / AMD Excavator+) |
| `apple-silicon` | Apple M1/M2/M3 chips |
| `armv8` | 64-bit ARM (Raspberry Pi 4, etc.) |

Run `make help` inside `engine/Stockfish/src` for the full list.

After building, verify the binary works:

```bash
echo "quit" | ./engine/Stockfish/src/stockfish
# Expected: "Stockfish 16 by the Stockfish developers ..."
```

### Using a System-Installed Stockfish

If you already have Stockfish installed (e.g. via `apt install stockfish` or `brew install stockfish`), you can skip the build step. The server auto-detects it in this order:

1. `STOCKFISH_BIN` environment variable (if set)
2. `engine/Stockfish/src/stockfish` (compiled from source)
3. `/usr/games/stockfish` (Debian/Ubuntu package location)
4. `stockfish` on `PATH`

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

### Troubleshooting

| Problem | Solution |
|---------|----------|
| `Stockfish is not available` | Build the engine (`cd engine/Stockfish/src && make build ARCH=x86-64`) or install it system-wide |
| `Engine timeout` errors | Increase the analysis depth/time settings, or check that the Stockfish binary runs correctly (`echo "quit" \| stockfish`) |
| Port already in use | Set a different port: `PORT=3000 npm start` |
| Board doesn't render | Ensure you have internet access (chessboard.js and chess.js load from CDN) |

## Engine Configuration

The engine pool spawns up to 4 Stockfish UCI worker processes (capped at the number of CPU cores). Each worker maintains a job queue for sequential command execution. An LRU cache (500 entries, 1-hour TTL) avoids recomputing previously analyzed positions.

## Tech Stack

- **Frontend**: Vanilla JS (ES modules), chess.js, chessboardjs, Canvas API
- **Backend**: Node.js (zero npm dependencies, built-in modules only)
- **Engine**: Stockfish 16 (compiled from source)
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
