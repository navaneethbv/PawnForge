import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// vendor/ holds the frontend libraries the server ships; they must stay byte-identical to the
// versions pinned in package.json so dependency updates and audits cover what users run.
const vendored = [
  ['vendor/chess.js', 'node_modules/chess.js/dist/esm/chess.js'],
  ['vendor/jquery.min.js', 'node_modules/jquery/dist/jquery.min.js'],
  ['vendor/chessboard-1.0.0.min.js', 'node_modules/@chrisoakman/chessboardjs/dist/chessboard-1.0.0.min.js'],
  ['vendor/chessboard-1.0.0.min.css', 'node_modules/@chrisoakman/chessboardjs/dist/chessboard-1.0.0.min.css']
];

for (const [copy, source] of vendored) {
  test(`${copy} matches the pinned package`, async () => {
    assert.ok((await readFile(copy)).equals(await readFile(source)), `Refresh ${copy} from ${source}`);
  });
}
