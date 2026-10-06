import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esm = await import('../src/index.js');
const cjs = require('../src/index.cjs');
const declaration = await readFile(new URL('../src/index.d.ts', import.meta.url), 'utf8');
const expected = Object.keys(cjs).sort();
const actual = Object.keys(esm).sort();
if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('ESM and CommonJS exports differ');
for (const name of expected) {
  if (!declaration.includes(name)) throw new Error(`Type declarations do not mention ${name}`);
}
console.log(`build verified ${expected.length} mirrored exports and declarations`);
