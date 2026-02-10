# PawnForge

PawnForge is a full-stack, anonymous chess analysis web app with a self-hosted engine API interface.

## Implemented

- Interactive board (drag/drop, FEN load, move list)
- `POST /api/analyze/position` (MultiPV Stockfish analysis)
- `POST /api/analyze/all-moves` SSE streaming analysis of every legal move
- `POST /api/analyze/game` full-game review from PGN + per-ply FEN sequence
- `GET /api/opening` opening/ECO detection
- Move-quality classification thresholds (best/good/inaccuracy/mistake/blunder)
- Piece badge explorer + global move ranking UI

## Run

```bash
npm run serve
```

By default PawnForge expects `stockfish` on PATH (or `/usr/games/stockfish`).
Set `STOCKFISH_BIN` to point at a specific binary.
