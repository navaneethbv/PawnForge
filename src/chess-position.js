import { Chess } from '../vendor/chess.js';

function hasPiece(position, square, type, color) {
  const piece = position.get(square);
  return piece?.type === type && piece.color === color;
}

function validateCastling(position, rights) {
  for (const [right, color, kingSquare, rookSquare] of [
    ['K', 'w', 'e1', 'h1'], ['Q', 'w', 'e1', 'a1'],
    ['k', 'b', 'e8', 'h8'], ['q', 'b', 'e8', 'a8']
  ]) {
    if (!rights.includes(right)) continue;
    if (!hasPiece(position, kingSquare, 'k', color) || !hasPiece(position, rookSquare, 'r', color)) {
      throw new Error('Invalid FEN: castling rights require the king and rook on their starting squares.');
    }
  }
}

function validateEnPassant(position, square, opponent) {
  if (square === '-') return;
  const pawnSquare = `${square[0]}${position.turn() === 'w' ? '5' : '4'}`;
  if (position.get(square) || !hasPiece(position, pawnSquare, 'p', opponent)) {
    throw new Error('Invalid FEN: en passant requires the pawn that just advanced two squares.');
  }
}

// Shared by manual position loading and the server's engine boundary.
export function createPosition(fen) {
  const position = new Chess(fen);
  const fields = fen.trim().split(/\s+/);
  const opponent = position.turn() === 'w' ? 'b' : 'w';
  const king = position.board().flat().find((piece) => piece?.type === 'k' && piece.color === opponent);
  if (position.isAttacked(king.square, position.turn())) {
    throw new Error('Invalid FEN: the side that just moved cannot leave its king in check.');
  }
  validateCastling(position, fields[2] || '-');
  validateEnPassant(position, fields[3] || '-', opponent);
  // Stockfish stores these counters in signed integers and doubles the move number.
  for (const [value, max] of [[fields[4] ?? '0', 2147483647], [fields[5] ?? '1', 1073741823]]) {
    if (!/^\d+$/.test(value) || Number(value) > max) throw new Error('Invalid FEN: move counter is out of range.');
  }
  return position;
}
