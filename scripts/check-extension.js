import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3, 'Chrome requires Manifest V3');
assert.match(manifest.version, /^\d+(\.\d+){0,3}$/, 'Extension version must have one to four numeric components');
assert.ok(manifest.version.split('.').every(part => Number(part) <= 65535), 'Version component exceeds Chrome limit');
assert.ok(manifest.name?.trim(), 'Extension name is required');
assert.ok(manifest.background?.service_worker, 'A background service worker is required');
assert.ok(manifest.content_scripts?.length, 'At least one content script is required');

const files = new Set([manifest.background.service_worker]);
for (const script of manifest.content_scripts) {
  assert.ok(script.matches?.length, 'Content scripts need URL match patterns');
  for (const file of [...(script.js || []), ...(script.css || [])]) files.add(file);
}
for (const file of Object.values(manifest.icons || {})) files.add(file);
if (manifest.action?.default_popup) files.add(manifest.action.default_popup);
for (const file of files) {
  assert.equal(typeof file, 'string', 'Manifest file references must be strings');
  assert.ok(!isAbsolute(file), `Extension asset must use a relative path: ${file}`);
  const path = await realpath(resolve(root, file));
  const relativePath = relative(root, path);
  assert.ok(relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath), `Extension asset escapes the repository: ${file}`);
  assert.ok((await stat(path)).isFile(), `Extension asset is not a file: ${file}`);
}
console.log(`Manifest V3 valid; ${files.size} referenced assets exist.`);
