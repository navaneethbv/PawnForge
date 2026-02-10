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

## Setup

### Prerequisites
- Node.js 18+
- C++ compiler (g++) for building Stockfish

### Build Stockfish
```bash
cd engine/Stockfish/src
make -j$(nproc) build ARCH=x86-64
```

### Run
```bash
npm start
```

The server starts at `http://localhost:4173` with Stockfish auto-detected from `engine/Stockfish/src/stockfish`.

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4173` | Server port |
| `STOCKFISH_BIN` | auto-detect | Path to Stockfish binary |

## Engine Configuration

Stockfish binary resolution order:
1. `STOCKFISH_BIN` environment variable
2. `engine/Stockfish/src/stockfish` (built-in)
3. `/usr/games/stockfish` (system)
4. `stockfish` on PATH

The engine pool creates workers up to 4 (capped at CPU count). Each worker manages a Stockfish UCI process with a job queue.

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
